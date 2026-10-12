import { PrivyClient } from '@privy-io/node';
import { config } from '../config.js';
import { AppError, asAppError } from '../errors.js';

const SOLANA_MAINNET_CAIP2 = 'solana:mainnet' as const;

export interface AgentDelegatedSigner {
  available(): boolean;
  resolveWalletId(userId: string, wallet: string): Promise<string>;
  signTransaction(walletId: string, wallet: string, transaction: string, idempotencyKey: string): Promise<string>;
  signAndSendSponsored(walletId: string, wallet: string, transaction: string, idempotencyKey: string): Promise<string>;
}

export class PrivyAgentDelegatedSigner implements AgentDelegatedSigner {
  private readonly client: PrivyClient | null;
  private readonly authorizationPrivateKey: string | null;
  private readonly requestTimeoutMs: number;

  constructor(input: { appId?: string; appSecret?: string; authorizationPrivateKey?: string; requestTimeoutMs?: number } = {
    appId: config.privyAppId,
    appSecret: config.privyAppSecret,
    authorizationPrivateKey: config.privyAuthorizationPrivateKey,
    requestTimeoutMs: config.privyAgentTimeoutMs,
  }) {
    this.authorizationPrivateKey = input.authorizationPrivateKey ?? null;
    this.requestTimeoutMs = input.requestTimeoutMs ?? config.privyAgentTimeoutMs;
    this.client = input.appId && input.appSecret && input.authorizationPrivateKey
      ? new PrivyClient({ appId: input.appId, appSecret: input.appSecret })
      : null;
  }

  available(): boolean {
    return Boolean(this.client && this.authorizationPrivateKey);
  }

  async resolveWalletId(userId: string, wallet: string): Promise<string> {
    const client = this.requireClient();
    try {
      const user = await this.withTimeout(
        client.users()._get(userId),
        'AGENT_DELEGATION_LOOKUP_TIMEOUT',
        'Privy took too long to verify this wallet delegation. Retry in a moment.',
      );
      const account = user.linked_accounts.find((candidate) => (
        candidate.type === 'wallet'
        && candidate.chain_type === 'solana'
        && 'connector_type' in candidate
        && candidate.connector_type === 'embedded'
        && 'wallet_client_type' in candidate
        && (candidate.wallet_client_type === 'privy' || candidate.wallet_client_type === 'privy-v2')
        && candidate.address === wallet
      ));
      if (!account || !('delegated' in account) || account.delegated !== true || !('id' in account) || typeof account.id !== 'string') {
        throw new AppError(409, 'AGENT_WALLET_NOT_DELEGATED', 'Approve the one-time Privy wallet delegation before creating automatic agent access.');
      }
      await this.assertWallet(account.id, wallet);
      return account.id;
    } catch (error) {
      if (error instanceof AppError) throw error;
      const appError = asAppError(error, 'AGENT_DELEGATION_LOOKUP_FAILED');
      throw new AppError(502, appError.code, 'Flay could not verify this wallet delegation with Privy. Retry in a moment.', true);
    }
  }

  async signTransaction(walletId: string, wallet: string, transaction: string, idempotencyKey: string): Promise<string> {
    const client = this.requireClient();
    await this.assertWallet(walletId, wallet);
    try {
      const result = await this.withTimeout(
        client.wallets().solana().signTransaction(walletId, {
          transaction,
          idempotency_key: idempotencyKey,
          authorization_context: { authorization_private_keys: [this.authorizationPrivateKey!] },
        }),
        'AGENT_PRIVY_SIGN_TIMEOUT',
        'Privy took too long to sign this automatic transaction. Retry with the same request.',
      );
      if (!result.signed_transaction) throw new AppError(502, 'AGENT_PRIVY_SIGNATURE_MISSING', 'Privy did not return the signed transaction.', true);
      return result.signed_transaction;
    } catch (error) {
      if (error instanceof AppError) throw error;
      const appError = asAppError(error, 'AGENT_PRIVY_SIGN_FAILED');
      throw new AppError(502, appError.code, 'Privy could not authorize this automatic transaction. The delegation may have been revoked.', true);
    }
  }

  async signAndSendSponsored(walletId: string, wallet: string, transaction: string, idempotencyKey: string): Promise<string> {
    const client = this.requireClient();
    await this.assertWallet(walletId, wallet);
    try {
      const result = await this.withTimeout(
        client.wallets().solana().signAndSendTransaction(walletId, {
          transaction,
          caip2: SOLANA_MAINNET_CAIP2,
          sponsor: true,
          idempotency_key: idempotencyKey,
          authorization_context: { authorization_private_keys: [this.authorizationPrivateKey!] },
        }),
        'AGENT_PRIVY_SEND_TIMEOUT',
        'Privy took too long to submit this automatic transaction. Retry with the same request.',
      );
      if (!result.hash) throw new AppError(502, 'AGENT_PRIVY_SIGNATURE_MISSING', 'Privy did not return the sponsored transaction signature.', true);
      return result.hash;
    } catch (error) {
      if (error instanceof AppError) throw error;
      const appError = asAppError(error, 'AGENT_PRIVY_SEND_FAILED');
      throw new AppError(502, appError.code, 'Privy could not authorize or sponsor this automatic transaction. The delegation may have been revoked.', true);
    }
  }

  private requireClient(): PrivyClient {
    if (!this.client || !this.authorizationPrivateKey) {
      throw new AppError(503, 'AGENT_AUTOMATIC_NOT_CONFIGURED', 'Automatic agent execution is not configured on this Flay deployment. Use Always ask for now.');
    }
    return this.client;
  }

  private async assertWallet(walletId: string, expectedAddress: string): Promise<void> {
    const client = this.requireClient();
    try {
      const wallet = await this.withTimeout(
        client.wallets().get(walletId),
        'AGENT_DELEGATED_WALLET_TIMEOUT',
        'Privy took too long to verify the delegated wallet. Retry in a moment.',
      );
      if (wallet.chain_type !== 'solana' || wallet.address !== expectedAddress) {
        throw new AppError(403, 'AGENT_DELEGATED_WALLET_MISMATCH', 'The delegated Privy wallet does not match this Agent capability.');
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(502, 'AGENT_DELEGATED_WALLET_UNAVAILABLE', 'Privy could not verify the delegated wallet before signing.', true);
    }
  }

  private async withTimeout<T>(operation: Promise<T>, code: string, message: string): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new AppError(504, code, message, true)), this.requestTimeoutMs);
    });
    try {
      return await Promise.race([operation, deadline]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
