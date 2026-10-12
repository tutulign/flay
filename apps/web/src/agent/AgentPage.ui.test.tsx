import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SOL_MINT } from '../../shared/constants.js';
import type { FlayAuth } from '../auth.js';
import AgentPage from './AgentPage.js';

function auth(authenticated: boolean, delegated = false): FlayAuth {
  return {
    configured: true,
    ready: true,
    authenticated,
    walletReady: authenticated,
    walletAddress: authenticated ? SOL_MINT : null,
    walletDelegated: delegated,
    identityToken: authenticated ? 'identity' : null,
    fiatOnrampEnvironment: 'sandbox',
    login: vi.fn(),
    logout: vi.fn(),
    exportWallet: vi.fn(),
    delegateWalletForAgent: vi.fn(),
    revokeAgentWalletDelegation: vi.fn(),
    signMessage: vi.fn(),
    signTransaction: vi.fn(),
    signAndSendSponsoredTransaction: vi.fn(),
    signAndSendSponsoredMarketTransaction: vi.fn(),
    fundUsdcWithFiat: vi.fn(),
  };
}

describe('Agent workspace UI', () => {
  it('explains the approval boundary before login', () => {
    const html = renderToStaticMarkup(<AgentPage auth={auth(false)} />);
    expect(html).toContain('Your wallet stays in charge.');
    expect(html).toContain('choose approval for every request or automatic execution');
    expect(html).toContain('Sign in to configure');
  });

  it('renders explicit guardrails and forbidden capability boundaries', () => {
    const html = renderToStaticMarkup(<AgentPage auth={auth(true)} />);
    expect(html).toContain('Set the guardrails');
    expect(html).toContain('Per request');
    expect(html).toContain('Maximum leverage');
    expect(html).toContain('No fiat or general wallet access');
    expect(html).toContain('Always ask');
    expect(html).toContain('Full access');
    expect(html).toContain('x402 APIs');
    expect(html).toContain('Automatic actions go directly to recent activity');
  });

  it('shows the owner control that revokes delegated automatic access', () => {
    const html = renderToStaticMarkup(<AgentPage auth={auth(true, true)} />);
    expect(html).toContain('Revoke automatic wallet access');
  });
});
