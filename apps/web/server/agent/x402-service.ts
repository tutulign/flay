import { createHash, randomUUID } from 'node:crypto';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import type { ClientSvmSigner } from '@x402/svm';
import { address } from '@solana/kit';
import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  decodeTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import nacl from 'tweetnacl';
import type {
  AgentX402ExecutionResult,
  AgentX402Intent,
  AgentX402PreparedPayment,
} from '../../shared/agent.js';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { SafeX402HttpTransport, type X402HttpTransport } from './x402-http.js';

export const X402_SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' as const;
export const X402_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const MAX_PREPARED_PAYMENTS = 2_000;
const MAX_PAYMENT_TIMEOUT_SECONDS = 600;

interface PreparedRecord {
  id: string;
  wallet: string;
  intent: AgentX402Intent;
  requestBody: string | undefined;
  bodySha256: string | null;
  idempotencyKey: string;
  paymentRequired: PaymentRequired;
  requirement: PaymentRequirements;
  payload: PaymentPayload;
  messageSha256: string;
  expiresAt: number;
  result: AgentX402ExecutionResult | null;
}

export type X402PaymentBuilder = (
  wallet: string,
  paymentRequired: PaymentRequired,
  requirement: PaymentRequirements,
) => Promise<PaymentPayload>;

export interface AgentX402Payments {
  prepare(wallet: string, intent: AgentX402Intent, idempotencyKey: string, policyMaximumAtomic: string): Promise<AgentX402PreparedPayment>;
  execute(preparedId: string, wallet: string, signedTransaction: string): Promise<AgentX402ExecutionResult>;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function publicKey(value: string, code: string, message: string): PublicKey {
  try {
    const key = new PublicKey(value);
    if (key.toBase58() !== value) throw new Error('noncanonical');
    return key;
  } catch {
    throw new AppError(400, code, message);
  }
}

function responseBodyForParsing(body: string): unknown {
  if (!body) return undefined;
  try { return JSON.parse(body); } catch { return undefined; }
}

function contentTypeAllowed(contentType: string, body: string): boolean {
  if (!body) return true;
  return contentType === 'application/json' || contentType.endsWith('+json') || contentType === 'text/plain';
}

function responseHeader(response: { headers: ReadonlyMap<string, string> }) {
  return (name: string) => response.headers.get(name.toLowerCase());
}

function chooseRequirement(
  paymentRequired: PaymentRequired,
  requestedUrl: string,
  callerMaximum: bigint,
  policyMaximum: bigint,
): PaymentRequirements {
  if (paymentRequired.x402Version !== 2) throw new AppError(409, 'X402_VERSION_UNSUPPORTED', 'Flay accepts x402 protocol v2 only.');
  let resourceUrl: URL;
  let targetUrl: URL;
  try {
    resourceUrl = new URL(paymentRequired.resource.url);
    targetUrl = new URL(requestedUrl);
  } catch {
    throw new AppError(409, 'X402_RESOURCE_INVALID', 'The x402 service returned invalid resource metadata.');
  }
  if (resourceUrl.protocol !== 'https:' || resourceUrl.origin !== targetUrl.origin) {
    throw new AppError(403, 'X402_RESOURCE_ORIGIN_MISMATCH', 'The x402 resource does not match the allowlisted service origin.');
  }

  const eligible = paymentRequired.accepts.filter((candidate) => (
    candidate.scheme === 'exact'
    && candidate.network === X402_SOLANA_MAINNET
    && candidate.asset === X402_USDC_MINT
    && /^[1-9]\d*$/.test(candidate.amount)
    && BigInt(candidate.amount) <= callerMaximum
    && BigInt(candidate.amount) <= policyMaximum
  )).sort((left, right) => {
    const leftAmount = BigInt(left.amount);
    const rightAmount = BigInt(right.amount);
    return leftAmount < rightAmount ? -1 : leftAmount > rightAmount ? 1 : 0;
  });
  const selected = eligible[0];
  if (!selected) {
    const exactMainnetUsdc = paymentRequired.accepts.find((candidate) => (
      candidate.scheme === 'exact'
      && candidate.network === X402_SOLANA_MAINNET
      && candidate.asset === X402_USDC_MINT
      && /^[1-9]\d*$/.test(candidate.amount)
    ));
    if (exactMainnetUsdc && (BigInt(exactMainnetUsdc.amount) > callerMaximum || BigInt(exactMainnetUsdc.amount) > policyMaximum)) {
      throw new AppError(403, 'X402_PAYMENT_LIMIT', 'The requested x402 payment exceeds the caller or owner ceiling.');
    }
    throw new AppError(409, 'X402_PAYMENT_UNSUPPORTED', 'This resource did not offer exact canonical USDC payment on Solana mainnet.');
  }
  if (!Number.isInteger(selected.maxTimeoutSeconds) || selected.maxTimeoutSeconds < 1 || selected.maxTimeoutSeconds > MAX_PAYMENT_TIMEOUT_SECONDS) {
    throw new AppError(409, 'X402_TIMEOUT_INVALID', 'The x402 payment timeout is outside Flay’s supported range.');
  }
  publicKey(selected.payTo, 'X402_RECIPIENT_INVALID', 'The x402 payment recipient is invalid.');
  const feePayer = selected.extra?.feePayer;
  if (typeof feePayer !== 'string') throw new AppError(409, 'X402_FEE_PAYER_MISSING', 'The x402 facilitator did not provide a Solana fee payer.');
  publicKey(feePayer, 'X402_FEE_PAYER_INVALID', 'The x402 facilitator fee payer is invalid.');
  return selected;
}

function validatePaymentTransaction(
  transactionBase64: string,
  walletAddress: string,
  requirement: PaymentRequirements,
): string {
  let transaction: VersionedTransaction;
  try { transaction = VersionedTransaction.deserialize(Buffer.from(transactionBase64, 'base64')); } catch {
    throw new AppError(409, 'X402_TRANSACTION_INVALID', 'The x402 SDK did not produce a valid Solana transaction.');
  }
  if (transaction.message.addressTableLookups.length) {
    throw new AppError(409, 'X402_TRANSACTION_UNSAFE', 'x402 payments with address lookup tables are not supported.');
  }
  const staticKeys = transaction.message.staticAccountKeys;
  const feePayer = staticKeys[0]?.toBase58();
  if (feePayer !== requirement.extra.feePayer) throw new AppError(409, 'X402_FEE_PAYER_MISMATCH', 'The x402 transaction changed its facilitator fee payer.');
  const requiredSigners = staticKeys.slice(0, transaction.message.header.numRequiredSignatures).map((key) => key.toBase58());
  if (!requiredSigners.includes(walletAddress)) throw new AppError(409, 'X402_SIGNER_MISMATCH', 'The x402 transaction does not require the capability wallet signature.');

  const message = TransactionMessage.decompile(transaction.message);
  const allowedPrograms = new Set([ComputeBudgetProgram.programId.toBase58(), TOKEN_PROGRAM_ID.toBase58(), MEMO_PROGRAM]);
  if (message.instructions.some((instruction) => !allowedPrograms.has(instruction.programId.toBase58()))) {
    throw new AppError(409, 'X402_TRANSACTION_UNSAFE', 'The x402 transaction contains an unexpected Solana program.');
  }
  const transfers = message.instructions.filter((instruction) => instruction.programId.equals(TOKEN_PROGRAM_ID));
  if (transfers.length !== 1) throw new AppError(409, 'X402_TRANSFER_INVALID', 'The x402 transaction must contain exactly one USDC transfer.');

  let decoded;
  try { decoded = decodeTransferCheckedInstruction(transfers[0], TOKEN_PROGRAM_ID); } catch {
    throw new AppError(409, 'X402_TRANSFER_INVALID', 'The x402 transaction does not contain a valid checked USDC transfer.');
  }
  const wallet = publicKey(walletAddress, 'X402_WALLET_INVALID', 'The x402 payer wallet is invalid.');
  const mint = new PublicKey(X402_USDC_MINT);
  const recipient = new PublicKey(requirement.payTo);
  const expectedSource = getAssociatedTokenAddressSync(mint, wallet, true, TOKEN_PROGRAM_ID);
  const expectedDestination = getAssociatedTokenAddressSync(mint, recipient, true, TOKEN_PROGRAM_ID);
  if (!decoded.keys.mint.pubkey.equals(mint)
    || !decoded.keys.source.pubkey.equals(expectedSource)
    || !decoded.keys.destination.pubkey.equals(expectedDestination)
    || !decoded.keys.owner.pubkey.equals(wallet)
    || decoded.data.amount !== BigInt(requirement.amount)
    || decoded.data.decimals !== 6) {
    throw new AppError(409, 'X402_TRANSFER_MISMATCH', 'The x402 transaction does not match the reviewed USDC payment.');
  }
  return sha256(transaction.message.serialize());
}

function validatePaymentPayload(
  payload: PaymentPayload,
  paymentRequired: PaymentRequired,
  requirement: PaymentRequirements,
): string {
  const accepted = payload.accepted;
  if (payload.x402Version !== 2
    || payload.resource?.url !== paymentRequired.resource.url
    || accepted.scheme !== requirement.scheme
    || accepted.network !== requirement.network
    || accepted.asset !== requirement.asset
    || accepted.amount !== requirement.amount
    || accepted.payTo !== requirement.payTo
    || accepted.maxTimeoutSeconds !== requirement.maxTimeoutSeconds
    || accepted.extra?.feePayer !== requirement.extra?.feePayer) {
    throw new AppError(409, 'X402_PAYLOAD_MISMATCH', 'The x402 SDK payload differs from the validated payment requirement.');
  }
  const transaction = payload.payload.transaction;
  if (typeof transaction !== 'string') throw new AppError(502, 'X402_TRANSACTION_MISSING', 'The x402 SDK did not return a Solana transaction.', true);
  return transaction;
}

function assertSignedMessage(transactionBase64: string, walletAddress: string, expectedDigest: string): void {
  let transaction: VersionedTransaction;
  try { transaction = VersionedTransaction.deserialize(Buffer.from(transactionBase64, 'base64')); } catch {
    throw new AppError(400, 'X402_SIGNED_TRANSACTION_INVALID', 'Privy returned an invalid x402 transaction.');
  }
  if (sha256(transaction.message.serialize()) !== expectedDigest) {
    throw new AppError(409, 'X402_SIGNED_MESSAGE_MISMATCH', 'The signed x402 transaction differs from the reviewed transaction.');
  }
  const signerKeys = transaction.message.staticAccountKeys.slice(0, transaction.message.header.numRequiredSignatures);
  const index = signerKeys.findIndex((key) => key.toBase58() === walletAddress);
  if (index < 0 || !transaction.signatures[index] || transaction.signatures[index].every((byte) => byte === 0)) {
    throw new AppError(409, 'X402_PAYER_SIGNATURE_MISSING', 'The x402 transaction is missing the Privy wallet signature.');
  }
  if (!nacl.sign.detached.verify(transaction.message.serialize(), transaction.signatures[index], signerKeys[index].toBytes())) {
    throw new AppError(409, 'X402_PAYER_SIGNATURE_INVALID', 'The x402 transaction has an invalid Privy wallet signature.');
  }
}

function explorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}`;
}

export class AgentX402Service implements AgentX402Payments {
  private readonly payments = new Map<string, PreparedRecord>();
  private readonly executions = new Map<string, Promise<AgentX402ExecutionResult>>();
  private readonly httpClient = new x402HTTPClient(new x402Client());

  constructor(
    private readonly transport: X402HttpTransport = new SafeX402HttpTransport(),
    private readonly rpcUrl: string = config.rpcUrl,
    private readonly paymentBuilder?: X402PaymentBuilder,
  ) {}

  async prepare(
    wallet: string,
    intent: AgentX402Intent,
    idempotencyKey: string,
    policyMaximumAtomic: string,
  ): Promise<AgentX402PreparedPayment> {
    this.sweep();
    if (this.payments.size >= MAX_PREPARED_PAYMENTS) throw new AppError(503, 'X402_PREPARED_CAPACITY', 'x402 payment preparation is temporarily at capacity.', true);
    const requestBody = intent.body === undefined ? undefined : JSON.stringify(intent.body);
    const initial = await this.transport.request({
      url: intent.url,
      method: intent.method,
      body: requestBody,
      idempotencyKey,
    });
    if (initial.bodyTruncated) {
      throw new AppError(502, 'X402_CHALLENGE_TOO_LARGE', 'The x402 payment challenge exceeds 64 KiB.');
    }
    if (initial.status !== 402) {
      throw new AppError(409, 'X402_PAYMENT_NOT_REQUIRED', initial.status >= 200 && initial.status < 300
        ? 'This resource completed without requesting an x402 payment.'
        : `The x402 service returned HTTP ${initial.status} before payment.`, initial.status >= 500);
    }

    let paymentRequired: PaymentRequired;
    try {
      paymentRequired = this.httpClient.getPaymentRequiredResponse(responseHeader(initial), responseBodyForParsing(initial.body));
    } catch {
      throw new AppError(409, 'X402_CHALLENGE_INVALID', 'The service returned HTTP 402 without a valid x402 v2 payment challenge.');
    }
    const requirement = chooseRequirement(
      paymentRequired,
      intent.url,
      BigInt(intent.maxPaymentAtomic),
      BigInt(policyMaximumAtomic),
    );
    let payload: PaymentPayload;
    try {
      payload = this.paymentBuilder
        ? await this.paymentBuilder(wallet, paymentRequired, requirement)
        : await this.buildPaymentPayload(wallet, paymentRequired, requirement);
    } catch {
      throw new AppError(502, 'X402_PAYMENT_BUILD_FAILED', 'Flay could not build the exact x402 USDC payment.', true);
    }
    const transaction = validatePaymentPayload(payload, paymentRequired, requirement);
    const messageSha256 = validatePaymentTransaction(transaction, wallet, requirement);
    const preparedId = randomUUID();
    const expiresAt = Date.now() + Math.min(requirement.maxTimeoutSeconds * 1_000, 90_000);
    const bodySha256 = requestBody === undefined ? null : sha256(requestBody);
    this.payments.set(preparedId, {
      id: preparedId,
      wallet,
      intent: structuredClone(intent),
      requestBody,
      bodySha256,
      idempotencyKey,
      paymentRequired,
      requirement,
      payload,
      messageSha256,
      expiresAt,
      result: null,
    });
    return {
      kind: 'x402-payment',
      preparedId,
      transaction,
      expiresAt,
      review: {
        url: intent.url,
        method: intent.method,
        resource: paymentRequired.resource.url,
        description: paymentRequired.resource.description ?? 'Paid x402 API resource',
        amountAtomic: requirement.amount,
        asset: requirement.asset,
        network: requirement.network,
        payTo: requirement.payTo,
        feePayer: String(requirement.extra.feePayer),
        bodySha256,
        warnings: ['The x402 facilitator sponsors the Solana network fee. Flay releases the API response only after a successful settlement receipt.'],
      },
    };
  }

  execute(preparedId: string, wallet: string, signedTransaction: string): Promise<AgentX402ExecutionResult> {
    const record = this.payments.get(preparedId);
    if (!record || record.wallet !== wallet) throw new AppError(404, 'X402_PREPARED_NOT_FOUND', 'This prepared x402 payment expired or belongs to another wallet.');
    if (record.result) return Promise.resolve(structuredClone(record.result));
    const active = this.executions.get(preparedId);
    if (active) return active;
    const execution = this.executeOnce(record, signedTransaction).finally(() => this.executions.delete(preparedId));
    this.executions.set(preparedId, execution);
    return execution;
  }

  private async executeOnce(record: PreparedRecord, signedTransaction: string): Promise<AgentX402ExecutionResult> {
    if (record.expiresAt <= Date.now()) throw new AppError(410, 'X402_PAYMENT_EXPIRED', 'The prepared x402 payment expired. Prepare it again.', true);
    assertSignedMessage(signedTransaction, record.wallet, record.messageSha256);
    const payload: PaymentPayload = {
      ...record.payload,
      payload: { ...record.payload.payload, transaction: signedTransaction },
    };
    const headers = this.httpClient.encodePaymentSignatureHeader(payload);
    const paid = await this.transport.request({
      url: record.intent.url,
      method: record.intent.method,
      body: record.requestBody,
      idempotencyKey: record.idempotencyKey,
      paymentSignature: headers['PAYMENT-SIGNATURE'] ?? headers['payment-signature'],
    });
    let settlement: SettleResponse;
    try { settlement = this.httpClient.getPaymentSettleResponse(responseHeader(paid)); } catch {
      throw new AppError(502, 'X402_SETTLEMENT_RECEIPT_MISSING', 'The paid service did not return a valid x402 settlement receipt.', true);
    }
    if (!settlement.success) throw new AppError(502, 'X402_SETTLEMENT_FAILED', settlement.errorMessage ?? settlement.errorReason ?? 'The x402 facilitator did not settle the payment.', true);
    if (settlement.network !== X402_SOLANA_MAINNET) throw new AppError(502, 'X402_SETTLEMENT_NETWORK_MISMATCH', 'The x402 settlement receipt reports a different network.');
    if (settlement.payer && settlement.payer !== record.wallet) throw new AppError(502, 'X402_SETTLEMENT_PAYER_MISMATCH', 'The x402 settlement receipt reports a different payer.');
    if (settlement.amount && settlement.amount !== record.requirement.amount) throw new AppError(502, 'X402_SETTLEMENT_AMOUNT_MISMATCH', 'The x402 settlement receipt reports a different amount.');
    if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(settlement.transaction)) throw new AppError(502, 'X402_SETTLEMENT_SIGNATURE_INVALID', 'The x402 settlement receipt has an invalid Solana signature.');
    if (paid.status < 200 || paid.status >= 300) throw new AppError(502, 'X402_RESOURCE_FAILED', `The paid x402 resource returned HTTP ${paid.status}.`, paid.status >= 500);
    if (!contentTypeAllowed(paid.contentType, paid.body)) throw new AppError(502, 'X402_RESPONSE_TYPE_DENIED', 'Flay accepts only bounded JSON or plain-text x402 responses.');
    if (!paid.bodyTruncated && paid.body && (paid.contentType === 'application/json' || paid.contentType.endsWith('+json'))) {
      try { JSON.parse(paid.body); } catch {
        throw new AppError(502, 'X402_RESPONSE_JSON_INVALID', 'The paid x402 resource returned malformed JSON.');
      }
    }

    const result: AgentX402ExecutionResult = {
      signature: settlement.transaction,
      status: 'confirmed',
      explorerUrl: explorerUrl(settlement.transaction),
      provider: 'x402',
      response: {
        url: record.intent.url,
        method: record.intent.method,
        amountAtomic: record.requirement.amount,
        asset: record.requirement.asset,
        network: record.requirement.network,
        payer: settlement.payer ?? record.wallet,
        payTo: record.requirement.payTo,
        responseStatus: paid.status,
        contentType: paid.contentType || 'text/plain',
        body: paid.body,
        bodyTruncated: paid.bodyTruncated,
      },
    };
    record.result = result;
    return structuredClone(result);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, payment] of this.payments) {
      if (!payment.result && payment.expiresAt <= now) this.payments.delete(id);
    }
    while (this.payments.size >= MAX_PREPARED_PAYMENTS) {
      const oldest = this.payments.keys().next().value as string | undefined;
      if (!oldest) break;
      this.payments.delete(oldest);
    }
  }

  private async buildPaymentPayload(
    wallet: string,
    paymentRequired: PaymentRequired,
    requirement: PaymentRequirements,
  ): Promise<PaymentPayload> {
    const noKeySigner: ClientSvmSigner = {
      address: address(wallet),
      signTransactions: async (transactions) => transactions.map(() => ({})),
    };
    const client = new x402Client()
      .register(X402_SOLANA_MAINNET, new ExactSvmScheme(noKeySigner, { rpcUrl: this.rpcUrl }))
      .setSpendControls(false);
    return client.createPaymentPayload({ ...paymentRequired, accepts: [requirement] });
  }
}
