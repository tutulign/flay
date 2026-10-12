import { PrivyProvider, useFiatOnramp, useHeadlessDelegatedActions, useIdentityToken, usePrivy, useSigners } from '@privy-io/react-auth';
import {
  useExportWallet,
  useFundWallet,
  useSignAndSendTransaction,
  useSignMessage,
  useSignTransaction,
  useWallets,
} from '@privy-io/react-auth/solana';
import { useMemo } from 'react';
import App from './App';
import type { FlayAuth } from './auth';
import PrivyOnrampCheckoutPage from './fiat/PrivyOnrampCheckoutPage';
import { delegateAgentWallet, revokeAgentWallet } from './privy-agent-delegation';
import { PRIVY_SPONSORED_SEND_CHAIN, PRIVY_SPONSORED_SEND_OPTIONS, privySponsoredMarketOptions, requirePrivySolanaSignature } from './privy-sponsored-send';
import { buildPrivyOnrampOptions, buildPrivyRegionalMoonPayRequest, parsePrivyOnrampCheckoutIntent, resolvePrivyOnrampEnvironment, resolvePrivyOnrampRoute } from './privy-fiat-onramp';

const fiatOnrampEnvironment = resolvePrivyOnrampEnvironment(import.meta.env.VITE_PRIVY_ONRAMP_ENV);
const privyAuthorizationKeyId = import.meta.env.VITE_PRIVY_AUTHORIZATION_KEY_ID?.trim() || null;

export function ConfiguredPrivyApp({ appId }: { appId: string }) {
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ['google', 'email'],
        appearance: {
          theme: 'light',
          accentColor: '#315b3b',
          walletChainType: 'solana-only',
          landingHeader: 'Sign in to Flay',
          loginMessage: 'One exportable Solana wallet for Flay.',
        },
        embeddedWallets: {
          solana: { createOnLogin: 'all-users' },
          showWalletUIs: true,
        },
      }}
    >
      <PrivyBridge />
    </PrivyProvider>
  );
}

function PrivyBridge() {
  const checkoutIntent = useMemo(() => parsePrivyOnrampCheckoutIntent(window.location.search), []);
  const fiatRoute = useMemo(
    () => checkoutIntent ? resolvePrivyOnrampRoute(fiatOnrampEnvironment) : null,
    [checkoutIntent],
  );
  const { ready, authenticated, user, login, logout } = usePrivy();
  const { identityToken } = useIdentityToken();
  const { ready: walletsReady, wallets } = useWallets();
  const { exportWallet } = useExportWallet();
  const { signMessage } = useSignMessage();
  const { signTransaction } = useSignTransaction();
  const { signAndSendTransaction } = useSignAndSendTransaction();
  const { fund } = useFiatOnramp();
  const { fundWallet } = useFundWallet();
  const { delegateWallet, revokeWallets } = useHeadlessDelegatedActions();
  const { addSigners, removeSigners } = useSigners();

  const embeddedAccount = user?.linkedAccounts.find((account) => (
    account.type === 'wallet'
    && account.chainType === 'solana'
    && (account.walletClientType === 'privy' || account.walletClientType === 'privy-v2')
    && account.connectorType === 'embedded'
  ));
  const embeddedAddress = embeddedAccount && 'address' in embeddedAccount ? embeddedAccount.address : null;
  const teeWallet = Boolean(embeddedAccount && 'id' in embeddedAccount && typeof embeddedAccount.id === 'string');
  const wallet = wallets.find((candidate) => candidate.address === embeddedAddress);

  const auth = useMemo<FlayAuth>(() => ({
    configured: true,
    ready,
    authenticated,
    walletReady: walletsReady && Boolean(wallet),
    walletAddress: wallet?.address ?? embeddedAddress,
    walletDelegated: Boolean(embeddedAccount && 'delegated' in embeddedAccount && embeddedAccount.delegated),
    identityToken,
    fiatOnrampEnvironment,
    login: () => login(),
    logout,
    exportWallet: async () => {
      if (!wallet?.address && !embeddedAddress) throw new Error('Your embedded Solana wallet is still loading.');
      await exportWallet({ address: wallet?.address ?? embeddedAddress! });
    },
    delegateWalletForAgent: async () => {
      const address = wallet?.address ?? embeddedAddress;
      if (!address) throw new Error('Your embedded Solana wallet is still loading.');
      await delegateAgentWallet({
        address,
        teeWallet,
        authorizationKeyId: privyAuthorizationKeyId,
        addSigners,
        delegateLegacy: delegateWallet,
      });
    },
    revokeAgentWalletDelegation: async () => {
      const address = wallet?.address ?? embeddedAddress;
      if (!address) throw new Error('Your embedded Solana wallet is still loading.');
      await revokeAgentWallet({ address, teeWallet, removeSigners, revokeLegacy: revokeWallets });
    },
    signMessage: async (message: Uint8Array) => {
      if (!wallet) throw new Error('Your embedded Solana wallet is still loading.');
      const result = await signMessage({
        message,
        wallet,
        options: {
          uiOptions: {
            showWalletUIs: true,
            title: 'Unlock protected balance',
            description: 'Sign MagicBlock\'s one-time login challenge. This cannot move funds.',
            buttonText: 'Sign and unlock',
            isCancellable: true,
          },
        },
      });
      return result.signature;
    },
    signTransaction: async (transaction: Uint8Array) => {
      if (!wallet) throw new Error('Your embedded Solana wallet is still loading.');
      const result = await signTransaction({
        transaction,
        wallet,
        options: { uiOptions: { showWalletUIs: false } },
      });
      return result.signedTransaction;
    },
    signAndSendSponsoredTransaction: async (transaction: Uint8Array) => {
      if (!wallet) throw new Error('Your embedded Solana wallet is still loading.');
      const result = await signAndSendTransaction({
        transaction,
        wallet,
        chain: PRIVY_SPONSORED_SEND_CHAIN,
        options: PRIVY_SPONSORED_SEND_OPTIONS,
      });
      return requirePrivySolanaSignature(result.signature);
    },
    signAndSendSponsoredMarketTransaction: async (transaction: Uint8Array, venue: 'Raydium' | 'Orca') => {
      if (!wallet) throw new Error('Your embedded Solana wallet is still loading.');
      const result = await signAndSendTransaction({
        transaction,
        wallet,
        chain: PRIVY_SPONSORED_SEND_CHAIN,
        options: privySponsoredMarketOptions(venue),
      });
      return requirePrivySolanaSignature(result.signature);
    },
    fundUsdcWithFiat: async ({ fiat, amount }) => {
      if (!authenticated || !wallet?.address) throw new Error('Your embedded Solana wallet is still loading.');
      const route = await (fiatRoute ?? resolvePrivyOnrampRoute(fiatOnrampEnvironment));
      if (route === 'moonpay') {
        await fundWallet(buildPrivyRegionalMoonPayRequest(wallet.address, fiat, amount));
        return { status: 'provider-exited' as const };
      }
      return fund(buildPrivyOnrampOptions(wallet.address, fiat, amount, fiatOnrampEnvironment));
    },
  }), [
    authenticated,
    addSigners,
    embeddedAddress,
    delegateWallet,
    exportWallet,
    fund,
    fundWallet,
    fiatRoute,
    identityToken,
    login,
    logout,
    ready,
    revokeWallets,
    removeSigners,
    signMessage,
    signAndSendTransaction,
    signTransaction,
    wallet,
    walletsReady,
    teeWallet,
  ]);

  return checkoutIntent
    ? <PrivyOnrampCheckoutPage auth={auth} intent={checkoutIntent} />
    : <App auth={auth} />;
}
