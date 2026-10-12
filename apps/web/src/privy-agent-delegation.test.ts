import { describe, expect, it, vi } from 'vitest';
import { delegateAgentWallet, revokeAgentWallet } from './privy-agent-delegation.js';

describe('Privy Agent wallet authorization', () => {
  it('adds the configured authorization key to a TEE wallet', async () => {
    const addSigners = vi.fn().mockResolvedValue(undefined);
    const delegateLegacy = vi.fn();

    await delegateAgentWallet({
      address: 'solana-wallet',
      teeWallet: true,
      authorizationKeyId: 'signer-id',
      addSigners,
      delegateLegacy,
    });

    expect(addSigners).toHaveBeenCalledWith({
      address: 'solana-wallet',
      signers: [{ signerId: 'signer-id' }],
    });
    expect(delegateLegacy).not.toHaveBeenCalled();
  });

  it('fails closed when a TEE wallet has no configured signer ID', async () => {
    await expect(delegateAgentWallet({
      address: 'solana-wallet',
      teeWallet: true,
      authorizationKeyId: null,
      addSigners: vi.fn(),
      delegateLegacy: vi.fn(),
    })).rejects.toThrow('authorization-key ID');
  });

  it('retains Privy delegated actions for an older on-device wallet', async () => {
    const addSigners = vi.fn();
    const delegateLegacy = vi.fn().mockResolvedValue(undefined);

    await delegateAgentWallet({
      address: 'solana-wallet',
      teeWallet: false,
      authorizationKeyId: 'signer-id',
      addSigners,
      delegateLegacy,
    });

    expect(delegateLegacy).toHaveBeenCalledWith({ address: 'solana-wallet', chainType: 'solana' });
    expect(addSigners).not.toHaveBeenCalled();
  });

  it('uses the matching revocation API for each execution environment', async () => {
    const removeSigners = vi.fn().mockResolvedValue(undefined);
    const revokeLegacy = vi.fn().mockResolvedValue(undefined);
    await revokeAgentWallet({ address: 'tee-wallet', teeWallet: true, removeSigners, revokeLegacy });
    expect(removeSigners).toHaveBeenCalledWith({ address: 'tee-wallet' });
    expect(revokeLegacy).not.toHaveBeenCalled();

    await revokeAgentWallet({ address: 'legacy-wallet', teeWallet: false, removeSigners, revokeLegacy });
    expect(revokeLegacy).toHaveBeenCalledOnce();
  });
});
