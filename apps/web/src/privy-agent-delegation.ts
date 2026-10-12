export interface AddPrivySignersInput {
  address: string;
  signers: Array<{ signerId: string }>;
}

interface DelegateAgentWalletInput {
  address: string;
  teeWallet: boolean;
  authorizationKeyId: string | null;
  addSigners(input: AddPrivySignersInput): Promise<unknown>;
  delegateLegacy(input: { address: string; chainType: 'solana' }): Promise<unknown>;
}

interface RevokeAgentWalletInput {
  address: string;
  teeWallet: boolean;
  removeSigners(input: { address: string }): Promise<unknown>;
  revokeLegacy(): Promise<unknown>;
}

export async function delegateAgentWallet(input: DelegateAgentWalletInput): Promise<void> {
  if (input.teeWallet) {
    if (!input.authorizationKeyId) {
      throw new Error('Full access is missing its Privy authorization-key ID.');
    }
    await input.addSigners({
      address: input.address,
      signers: [{ signerId: input.authorizationKeyId }],
    });
    return;
  }
  await input.delegateLegacy({ address: input.address, chainType: 'solana' });
}

export async function revokeAgentWallet(input: RevokeAgentWalletInput): Promise<void> {
  if (input.teeWallet) {
    await input.removeSigners({ address: input.address });
    return;
  }
  await input.revokeLegacy();
}
