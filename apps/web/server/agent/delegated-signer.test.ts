import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SOL_MINT, USDC_MINT } from '../../shared/constants.js';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getWallet: vi.fn(),
  signTransaction: vi.fn(),
  signAndSendTransaction: vi.fn(),
}));

vi.mock('@privy-io/node', () => ({
  PrivyClient: class {
    users() { return { _get: mocks.getUser }; }
    wallets() {
      return {
        get: mocks.getWallet,
        solana: () => ({ signTransaction: mocks.signTransaction, signAndSendTransaction: mocks.signAndSendTransaction }),
      };
    }
  },
}));

import { PrivyAgentDelegatedSigner } from './delegated-signer.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({
    linked_accounts: [{
      type: 'wallet', chain_type: 'solana', connector_type: 'embedded', wallet_client_type: 'privy',
      address: SOL_MINT, delegated: true, id: 'wallet-id',
    }],
  });
  mocks.getWallet.mockResolvedValue({ id: 'wallet-id', address: SOL_MINT, chain_type: 'solana' });
  mocks.signTransaction.mockResolvedValue({ signed_transaction: 'signed-base64' });
  mocks.signAndSendTransaction.mockResolvedValue({ hash: 'base58-signature' });
});

describe('Privy delegated Agent signer', () => {
  it('resolves only the authenticated user’s delegated embedded Solana wallet', async () => {
    const signer = new PrivyAgentDelegatedSigner({ appId: 'app', appSecret: 'secret', authorizationPrivateKey: 'private-key' });
    await expect(signer.resolveWalletId('did:privy:user', SOL_MINT)).resolves.toBe('wallet-id');
    expect(mocks.getUser).toHaveBeenCalledWith('did:privy:user');
    expect(mocks.getWallet).toHaveBeenCalledWith('wallet-id');
  });

  it('fails closed when the exact embedded Solana wallet is not delegated', async () => {
    const signer = new PrivyAgentDelegatedSigner({ appId: 'app', appSecret: 'secret', authorizationPrivateKey: 'private-key' });
    mocks.getUser.mockResolvedValueOnce({
      linked_accounts: [{
        type: 'wallet', chain_type: 'solana', connector_type: 'embedded', wallet_client_type: 'privy',
        address: SOL_MINT, delegated: false, id: 'wallet-id',
      }],
    });
    await expect(signer.resolveWalletId('did:privy:user', SOL_MINT))
      .rejects.toMatchObject({ code: 'AGENT_WALLET_NOT_DELEGATED' });
    expect(mocks.getWallet).not.toHaveBeenCalled();
  });

  it('checks wallet ID, address, and chain before every signing operation', async () => {
    const signer = new PrivyAgentDelegatedSigner({ appId: 'app', appSecret: 'secret', authorizationPrivateKey: 'private-key' });
    mocks.getWallet.mockResolvedValueOnce({ id: 'wallet-id', address: USDC_MINT, chain_type: 'solana' });
    await expect(signer.signTransaction('wallet-id', SOL_MINT, 'transaction', 'request-id'))
      .rejects.toMatchObject({ code: 'AGENT_DELEGATED_WALLET_MISMATCH' });
    expect(mocks.signTransaction).not.toHaveBeenCalled();
  });

  it('passes the server authorization key internally and returns only provider results', async () => {
    const signer = new PrivyAgentDelegatedSigner({ appId: 'app', appSecret: 'secret', authorizationPrivateKey: 'private-key' });
    await expect(signer.signTransaction('wallet-id', SOL_MINT, 'transaction', 'request-id')).resolves.toBe('signed-base64');
    expect(mocks.signTransaction).toHaveBeenCalledWith('wallet-id', expect.objectContaining({
      transaction: 'transaction', idempotency_key: 'request-id',
      authorization_context: { authorization_private_keys: ['private-key'] },
    }));
    await expect(signer.signAndSendSponsored('wallet-id', SOL_MINT, 'transaction', 'sponsored-id')).resolves.toBe('base58-signature');
    expect(mocks.signAndSendTransaction).toHaveBeenCalledWith('wallet-id', expect.objectContaining({ sponsor: true, caip2: 'solana:mainnet' }));
  });

  it('is unavailable without every server-only setting', () => {
    expect(new PrivyAgentDelegatedSigner({ appId: 'app', appSecret: 'secret' }).available()).toBe(false);
  });

  it('bounds a stalled Privy delegation lookup with a retryable error', async () => {
    mocks.getUser.mockReturnValueOnce(new Promise(() => undefined));
    const signer = new PrivyAgentDelegatedSigner({
      appId: 'app', appSecret: 'secret', authorizationPrivateKey: 'private-key', requestTimeoutMs: 5,
    });
    await expect(signer.resolveWalletId('did:privy:user', SOL_MINT)).rejects.toMatchObject({
      code: 'AGENT_DELEGATION_LOOKUP_TIMEOUT', status: 504, retryable: true,
    });
  });
});
