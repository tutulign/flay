import { randomBytes, randomUUID } from 'node:crypto';
import { encodePaymentRequiredHeader, encodePaymentResponseHeader, decodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { describe, expect, it, vi } from 'vitest';
import type { X402HttpRequest, X402HttpResponse, X402HttpTransport } from './x402-http.js';
import {
  AgentX402Service,
  X402_SOLANA_MAINNET,
  X402_USDC_MINT,
  type X402PaymentBuilder,
} from './x402-service.js';

const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

function headers(values: Record<string, string>): ReadonlyMap<string, string> {
  return new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
}

function response(status: number, values: Record<string, string>, body = '', bodyTruncated = false): X402HttpResponse {
  const responseHeaders = headers(values);
  return {
    status,
    headers: responseHeaders,
    body,
    bodyTruncated,
    contentType: responseHeaders.get('content-type')?.split(';')[0] ?? '',
  };
}

function signature(): string {
  return bs58.encode(randomBytes(64));
}

class ScriptedTransport implements X402HttpTransport {
  readonly calls: X402HttpRequest[] = [];

  constructor(private readonly responses: X402HttpResponse[]) {}

  async request(input: X402HttpRequest): Promise<X402HttpResponse> {
    this.calls.push(structuredClone(input));
    const next = this.responses.shift();
    if (!next) throw new Error('Unexpected request');
    return next;
  }
}

function challenge(feePayer: string, payTo: string, overrides: Partial<PaymentRequirements> = {}): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: 'https://paid.example/report', description: 'One market report', mimeType: 'application/json' },
    accepts: [{
      scheme: 'exact',
      network: X402_SOLANA_MAINNET,
      asset: X402_USDC_MINT,
      amount: '1',
      payTo,
      maxTimeoutSeconds: 60,
      extra: { feePayer },
      ...overrides,
    }],
  };
}

function transactionBuilder(wallet: Keypair, feePayer: PublicKey, wrongDestination = false): X402PaymentBuilder {
  return async (_wallet, paymentRequired, requirement): Promise<PaymentPayload> => {
    const mint = new PublicKey(X402_USDC_MINT);
    const source = getAssociatedTokenAddressSync(mint, wallet.publicKey, true, TOKEN_PROGRAM_ID);
    const recipient = wrongDestination ? Keypair.generate().publicKey : new PublicKey(requirement.payTo);
    const destination = getAssociatedTokenAddressSync(mint, recipient, true, TOKEN_PROGRAM_ID);
    const message = new TransactionMessage({
      payerKey: feePayer,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 25_000 }),
        createTransferCheckedInstruction(source, mint, destination, wallet.publicKey, BigInt(requirement.amount), 6),
        new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from('x402-test') }),
      ],
    }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    return {
      x402Version: 2,
      resource: paymentRequired.resource,
      accepted: requirement,
      payload: { transaction: Buffer.from(transaction.serialize()).toString('base64') },
    };
  };
}

function signPrepared(transactionBase64: string, wallet: Keypair): string {
  const transaction = VersionedTransaction.deserialize(Buffer.from(transactionBase64, 'base64'));
  transaction.sign([wallet]);
  return Buffer.from(transaction.serialize()).toString('base64');
}

describe('Agent x402 exact-SVM payments', () => {
  it('prepares a one-micro-USDC payment and releases JSON only after a successful receipt', async () => {
    const wallet = Keypair.generate();
    const feePayer = Keypair.generate().publicKey;
    const payTo = Keypair.generate().publicKey;
    const required = challenge(feePayer.toBase58(), payTo.toBase58());
    const settlementSignature = signature();
    const transport = new ScriptedTransport([
      response(402, { 'payment-required': encodePaymentRequiredHeader(required), 'content-type': 'application/json' }, '{}'),
      response(200, {
        'payment-response': encodePaymentResponseHeader({
          success: true,
          payer: wallet.publicKey.toBase58(),
          transaction: settlementSignature,
          network: X402_SOLANA_MAINNET,
          amount: '1',
        }),
        'content-type': 'application/json',
      }, '{"answer":42}'),
    ]);
    const service = new AgentX402Service(transport, 'https://rpc.invalid', transactionBuilder(wallet, feePayer));
    const idempotencyKey = randomUUID();
    const prepared = await service.prepare(wallet.publicKey.toBase58(), {
      kind: 'x402', url: 'https://paid.example/report', method: 'POST', body: { market: 'SOL' }, maxPaymentAtomic: '10',
    }, idempotencyKey, '100');

    expect(prepared.review).toMatchObject({ amountAtomic: '1', asset: X402_USDC_MINT, network: X402_SOLANA_MAINNET, payTo: payTo.toBase58(), feePayer: feePayer.toBase58() });
    const result = await service.execute(prepared.preparedId, wallet.publicKey.toBase58(), signPrepared(prepared.transaction, wallet));
    expect(result).toMatchObject({
      signature: settlementSignature,
      status: 'confirmed',
      response: { amountAtomic: '1', responseStatus: 200, contentType: 'application/json', body: '{"answer":42}', bodyTruncated: false },
    });
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[1]).toMatchObject({ idempotencyKey, paymentSignature: expect.any(String) });
    expect(transport.calls.map((call) => call.body)).toEqual(['{"market":"SOL"}', '{"market":"SOL"}']);
    expect(prepared.review.bodySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(decodePaymentSignatureHeader(transport.calls[1].paymentSignature!).payload.transaction).toBeTruthy();
  });

  it('rejects alternate networks, over-limit prices, and mismatched transfer destinations before signing', async () => {
    const wallet = Keypair.generate();
    const feePayer = Keypair.generate().publicKey;
    const payTo = Keypair.generate().publicKey;
    const cases: Array<{ required: PaymentRequired; code: string; wrongDestination?: boolean }> = [
      { required: challenge(feePayer.toBase58(), payTo.toBase58(), { network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' }), code: 'X402_PAYMENT_UNSUPPORTED' },
      { required: challenge(feePayer.toBase58(), payTo.toBase58(), { asset: Keypair.generate().publicKey.toBase58() }), code: 'X402_PAYMENT_UNSUPPORTED' },
      { required: challenge(feePayer.toBase58(), payTo.toBase58(), { amount: '101' }), code: 'X402_PAYMENT_LIMIT' },
      { required: challenge(feePayer.toBase58(), payTo.toBase58()), code: 'X402_TRANSFER_MISMATCH', wrongDestination: true },
    ];
    for (const item of cases) {
      const transport = new ScriptedTransport([response(402, { 'payment-required': encodePaymentRequiredHeader(item.required) })]);
      const builder = vi.fn(transactionBuilder(wallet, feePayer, item.wrongDestination));
      const service = new AgentX402Service(transport, 'https://rpc.invalid', builder);
      await expect(service.prepare(wallet.publicKey.toBase58(), {
        kind: 'x402', url: 'https://paid.example/report', method: 'GET', maxPaymentAtomic: '100',
      }, randomUUID(), '100')).rejects.toMatchObject({ code: item.code });
      if (item.code !== 'X402_TRANSFER_MISMATCH') expect(builder).not.toHaveBeenCalled();
    }
  });

  it('rejects a changed signed message and never sends the paid request', async () => {
    const wallet = Keypair.generate();
    const feePayer = Keypair.generate().publicKey;
    const payTo = Keypair.generate().publicKey;
    const transport = new ScriptedTransport([response(402, {
      'payment-required': encodePaymentRequiredHeader(challenge(feePayer.toBase58(), payTo.toBase58())),
    })]);
    const service = new AgentX402Service(transport, 'https://rpc.invalid', transactionBuilder(wallet, feePayer));
    const prepared = await service.prepare(wallet.publicKey.toBase58(), {
      kind: 'x402', url: 'https://paid.example/report', method: 'GET', maxPaymentAtomic: '10',
    }, randomUUID(), '10');
    const changed = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, 'base64'));
    changed.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
    changed.sign([wallet]);
    await expect(service.execute(prepared.preparedId, wallet.publicKey.toBase58(), Buffer.from(changed.serialize()).toString('base64')))
      .rejects.toMatchObject({ code: 'X402_SIGNED_MESSAGE_MISMATCH' });
    expect(transport.calls).toHaveLength(1);
  });

  it('rejects a forged payer signature and an SDK payload that changes the accepted requirement', async () => {
    const wallet = Keypair.generate();
    const feePayer = Keypair.generate().publicKey;
    const payTo = Keypair.generate().publicKey;
    const required = challenge(feePayer.toBase58(), payTo.toBase58());

    const forgedTransport = new ScriptedTransport([response(402, { 'payment-required': encodePaymentRequiredHeader(required) })]);
    const forgedService = new AgentX402Service(forgedTransport, 'https://rpc.invalid', transactionBuilder(wallet, feePayer));
    const prepared = await forgedService.prepare(wallet.publicKey.toBase58(), {
      kind: 'x402', url: 'https://paid.example/report', method: 'GET', maxPaymentAtomic: '10',
    }, randomUUID(), '10');
    const forged = VersionedTransaction.deserialize(Buffer.from(signPrepared(prepared.transaction, wallet), 'base64'));
    forged.signatures[1][0] ^= 1;
    await expect(forgedService.execute(prepared.preparedId, wallet.publicKey.toBase58(), Buffer.from(forged.serialize()).toString('base64')))
      .rejects.toMatchObject({ code: 'X402_PAYER_SIGNATURE_INVALID' });
    expect(forgedTransport.calls).toHaveLength(1);

    const mismatchTransport = new ScriptedTransport([response(402, { 'payment-required': encodePaymentRequiredHeader(required) })]);
    const validBuilder = transactionBuilder(wallet, feePayer);
    const mismatchBuilder: X402PaymentBuilder = async (...args) => {
      const payload = await validBuilder(...args);
      return { ...payload, accepted: { ...payload.accepted, amount: '2' } };
    };
    const mismatchService = new AgentX402Service(mismatchTransport, 'https://rpc.invalid', mismatchBuilder);
    await expect(mismatchService.prepare(wallet.publicKey.toBase58(), {
      kind: 'x402', url: 'https://paid.example/report', method: 'GET', maxPaymentAtomic: '10',
    }, randomUUID(), '10')).rejects.toMatchObject({ code: 'X402_PAYLOAD_MISMATCH' });
  });

  it('coalesces concurrent execution and returns the settled result without paying twice', async () => {
    const wallet = Keypair.generate();
    const feePayer = Keypair.generate().publicKey;
    const payTo = Keypair.generate().publicKey;
    const settlementSignature = signature();
    const transport = new ScriptedTransport([
      response(402, { 'payment-required': encodePaymentRequiredHeader(challenge(feePayer.toBase58(), payTo.toBase58())) }),
      response(200, {
        'payment-response': encodePaymentResponseHeader({
          success: true, payer: wallet.publicKey.toBase58(), transaction: settlementSignature,
          network: X402_SOLANA_MAINNET, amount: '1',
        }),
        'content-type': 'text/plain',
      }, 'paid'),
    ]);
    const service = new AgentX402Service(transport, 'https://rpc.invalid', transactionBuilder(wallet, feePayer));
    const prepared = await service.prepare(wallet.publicKey.toBase58(), {
      kind: 'x402', url: 'https://paid.example/report', method: 'GET', maxPaymentAtomic: '10',
    }, randomUUID(), '10');
    const signed = signPrepared(prepared.transaction, wallet);
    const [first, second] = await Promise.all([
      service.execute(prepared.preparedId, wallet.publicKey.toBase58(), signed),
      service.execute(prepared.preparedId, wallet.publicKey.toBase58(), signed),
    ]);
    expect(first).toEqual(second);
    expect((await service.execute(prepared.preparedId, wallet.publicKey.toBase58(), signed)).response.body).toBe('paid');
    expect(transport.calls).toHaveLength(2);
  });

  it('withholds the resource body when the settlement receipt is absent', async () => {
    const wallet = Keypair.generate();
    const feePayer = Keypair.generate().publicKey;
    const payTo = Keypair.generate().publicKey;
    const transport = new ScriptedTransport([
      response(402, { 'payment-required': encodePaymentRequiredHeader(challenge(feePayer.toBase58(), payTo.toBase58())) }),
      response(200, { 'content-type': 'application/json' }, '{"secret":"must not escape"}'),
    ]);
    const service = new AgentX402Service(transport, 'https://rpc.invalid', transactionBuilder(wallet, feePayer));
    const prepared = await service.prepare(wallet.publicKey.toBase58(), {
      kind: 'x402', url: 'https://paid.example/report', method: 'GET', maxPaymentAtomic: '10',
    }, randomUUID(), '10');
    await expect(service.execute(prepared.preparedId, wallet.publicKey.toBase58(), signPrepared(prepared.transaction, wallet)))
      .rejects.toMatchObject({ code: 'X402_SETTLEMENT_RECEIPT_MISSING' });
  });

  it('rejects an oversized challenge before signing but records a settled payment with a bounded response prefix', async () => {
    const wallet = Keypair.generate();
    const feePayer = Keypair.generate().publicKey;
    const payTo = Keypair.generate().publicKey;
    const required = challenge(feePayer.toBase58(), payTo.toBase58());
    const builder = vi.fn(transactionBuilder(wallet, feePayer));
    const oversizedChallenge = new AgentX402Service(new ScriptedTransport([
      response(402, { 'payment-required': encodePaymentRequiredHeader(required) }, '{}', true),
    ]), 'https://rpc.invalid', builder);
    await expect(oversizedChallenge.prepare(wallet.publicKey.toBase58(), {
      kind: 'x402', url: 'https://paid.example/report', method: 'GET', maxPaymentAtomic: '10',
    }, randomUUID(), '10')).rejects.toMatchObject({ code: 'X402_CHALLENGE_TOO_LARGE' });
    expect(builder).not.toHaveBeenCalled();

    const settlementSignature = signature();
    const settled = new AgentX402Service(new ScriptedTransport([
      response(402, { 'payment-required': encodePaymentRequiredHeader(required) }),
      response(200, {
        'payment-response': encodePaymentResponseHeader({
          success: true, payer: wallet.publicKey.toBase58(), transaction: settlementSignature,
          network: X402_SOLANA_MAINNET, amount: '1',
        }),
        'content-type': 'application/json',
      }, '{"boundedPrefix":', true),
    ]), 'https://rpc.invalid', transactionBuilder(wallet, feePayer));
    const prepared = await settled.prepare(wallet.publicKey.toBase58(), {
      kind: 'x402', url: 'https://paid.example/report', method: 'GET', maxPaymentAtomic: '10',
    }, randomUUID(), '10');
    await expect(settled.execute(
      prepared.preparedId,
      wallet.publicKey.toBase58(),
      signPrepared(prepared.transaction, wallet),
    )).resolves.toMatchObject({
      signature: settlementSignature,
      status: 'confirmed',
      response: { body: '{"boundedPrefix":', bodyTruncated: true },
    });
  });

  it('fails closed on failed settlements and unsafe or malformed paid responses', async () => {
    const wallet = Keypair.generate();
    const feePayer = Keypair.generate().publicKey;
    const payTo = Keypair.generate().publicKey;
    const settlementSignature = signature();
    const successHeader = encodePaymentResponseHeader({
      success: true, payer: wallet.publicKey.toBase58(), transaction: settlementSignature,
      network: X402_SOLANA_MAINNET, amount: '1',
    });
    const cases = [
      {
        code: 'X402_SETTLEMENT_FAILED',
        paid: response(200, {
          'payment-response': encodePaymentResponseHeader({
            success: false, transaction: '', network: X402_SOLANA_MAINNET, errorReason: 'settlement_failed',
          }),
          'content-type': 'application/json',
        }, '{"mustNotEscape":true}'),
      },
      {
        code: 'X402_RESPONSE_TYPE_DENIED',
        paid: response(200, { 'payment-response': successHeader, 'content-type': 'application/octet-stream' }, 'binary'),
      },
      {
        code: 'X402_RESPONSE_JSON_INVALID',
        paid: response(200, { 'payment-response': successHeader, 'content-type': 'application/json' }, '{broken'),
      },
    ];
    for (const item of cases) {
      const transport = new ScriptedTransport([
        response(402, { 'payment-required': encodePaymentRequiredHeader(challenge(feePayer.toBase58(), payTo.toBase58())) }),
        item.paid,
      ]);
      const service = new AgentX402Service(transport, 'https://rpc.invalid', transactionBuilder(wallet, feePayer));
      const prepared = await service.prepare(wallet.publicKey.toBase58(), {
        kind: 'x402', url: 'https://paid.example/report', method: 'GET', maxPaymentAtomic: '10',
      }, randomUUID(), '10');
      await expect(service.execute(prepared.preparedId, wallet.publicKey.toBase58(), signPrepared(prepared.transaction, wallet)))
        .rejects.toMatchObject({ code: item.code });
    }
  });
});
