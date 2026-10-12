import {
  AlertCircle,
  Bot,
  Check,
  CheckCircle2,
  Clipboard,
  Clock3,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Zap,
  X,
  XCircle,
} from 'lucide-react';
import bs58 from 'bs58';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { atomicToDecimal } from '../../shared/amounts';
import type {
  AgentCredentialCreated,
  AgentCredentialSummary,
  AgentExecutionResponse,
  AgentIntent,
  AgentPolicyInput,
  AgentRequest,
  AgentReviewResponse,
  AgentWorkspaceResponse,
} from '../../shared/agent';
import { CORE_TOKEN_MINTS } from '../../shared/constants';
import type { FlayAuth } from '../auth';
import { api, ApiClientError, fromBase64, query, readableError, toBase64 } from '../lib/api';
import { waitForAgentDelegation } from './delegation';
import './agent.css';

interface AgentPageProps {
  auth: FlayAuth;
  onTransactionCompleted?: (execution: AgentExecutionResponse, review: AgentReviewResponse) => void;
  onAutomaticTransactionCompleted?: (request: AgentRequest) => void;
}

const DEFAULT_STOCKS = ['AAPLX', 'NVDAX', 'TSLAX', 'MSFTX'];
const DEFAULT_MARKETS: AgentPolicyInput['allowedFuturesMarkets'] = ['SOL-PERP', 'BTC-PERP', 'ETH-PERP'];

interface PolicyForm {
  name: string;
  approvalMode: AgentPolicyInput['approvalMode'];
  products: AgentPolicyInput['products'];
  maxTransactionUsd: string;
  maxDailyUsd: string;
  maxSlippageBps: string;
  maxFuturesLeverage: string;
  maxOpenFuturesPositions: string;
  allowedTokenMints: string;
  allowedStockSymbols: string;
  allowedFuturesMarkets: AgentPolicyInput['allowedFuturesMarkets'];
  expiresInHours: string;
}

const DEFAULT_FORM: PolicyForm = {
  name: 'My trading agent',
  approvalMode: 'always-ask',
  products: ['convert', 'stocks', 'futures'],
  maxTransactionUsd: '25',
  maxDailyUsd: '100',
  maxSlippageBps: '50',
  maxFuturesLeverage: '3',
  maxOpenFuturesPositions: '2',
  allowedTokenMints: CORE_TOKEN_MINTS.join(', '),
  allowedStockSymbols: DEFAULT_STOCKS.join(', '),
  allowedFuturesMarkets: DEFAULT_MARKETS,
  expiresInHours: '24',
};

function short(value: string, size = 5) {
  return value.length > size * 2 ? `${value.slice(0, size)}…${value.slice(-size)}` : value;
}

function formatDate(value: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(value);
}

function formatRisk(microUsd: string) {
  const value = Number(microUsd) / 1_000_000;
  return Number.isFinite(value) ? new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value) : '—';
}

function intentTitle(intent: AgentIntent) {
  if (intent.kind === 'convert') return 'Convert tokens';
  if (intent.kind === 'stock') return `${intent.side === 'buy' ? 'Buy' : 'Sell'} ${intent.symbol}`;
  if (intent.kind === 'futures-open') return `${intent.side === 'long' ? 'Long' : 'Short'} ${intent.market}`;
  return `${intent.action === 'close' ? 'Close position' : 'Cancel order'} · ${intent.market}`;
}

function intentDetail(intent: AgentIntent) {
  if (intent.kind === 'convert') return `${intent.amountAtomic} atomic units · ${intent.slippageBps / 100}% max slippage`;
  if (intent.kind === 'stock') return `${intent.amount} ${intent.side === 'buy' ? 'USDC' : intent.symbol} · ${intent.slippageBps / 100}% max slippage`;
  if (intent.kind === 'futures-open') return `${atomicToDecimal(intent.collateralAtomic, 6)} USDC collateral · ${intent.leverageBps / 10_000}× · ${intent.routeChoice}`;
  return `${intent.venue} · ${short(intent.nativeId, 7)}`;
}

function statusClass(status: AgentRequest['status'] | AgentCredentialSummary['status']) {
  if (status === 'completed' || status === 'active') return 'positive';
  if (status === 'failed' || status === 'rejected' || status === 'revoked') return 'negative';
  if (status === 'expired') return 'muted';
  return 'pending';
}

function splitValues(value: string) {
  return [...new Set(value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))];
}

function errorMessage(error: unknown) {
  return readableError(error);
}

export default function AgentPage({ auth, onTransactionCompleted, onAutomaticTransactionCompleted }: AgentPageProps) {
  const [workspace, setWorkspace] = useState<AgentWorkspaceResponse | null>(null);
  const [form, setForm] = useState<PolicyForm>(DEFAULT_FORM);
  const [created, setCreated] = useState<AgentCredentialCreated | null>(null);
  const [review, setReview] = useState<AgentReviewResponse | null>(null);
  const [execution, setExecution] = useState<AgentExecutionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const reconciledAutomatic = useRef(new Set<string>());

  const load = useCallback(async (quiet = false) => {
    if (!auth.walletAddress || !auth.identityToken) {
      setWorkspace(null);
      return;
    }
    if (!quiet) setLoading(true);
    try {
      const next = await api<AgentWorkspaceResponse>(`/agent/workspace?${query({ wallet: auth.walletAddress })}`, { identityToken: auth.identityToken });
      setWorkspace(next);
      for (const request of next.requests) {
        if (request.approvalMode !== 'automatic' || request.status !== 'completed' || !request.execution || reconciledAutomatic.current.has(request.id)) continue;
        reconciledAutomatic.current.add(request.id);
        try { onAutomaticTransactionCompleted?.(request); } catch { /* Workspace completion remains authoritative if local reconciliation fails. */ }
      }
      if (!quiet) setError(null);
    } catch (caught) {
      if (!quiet) setError(errorMessage(caught));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [auth.identityToken, auth.walletAddress, onAutomaticTransactionCompleted]);

  useEffect(() => {
    void load();
    if (!auth.authenticated) return undefined;
    const timer = window.setInterval(() => void load(true), 8_000);
    return () => window.clearInterval(timer);
  }, [auth.authenticated, load]);

  const activeCredentialCount = useMemo(() => workspace?.credentials.filter((item) => item.status === 'active').length ?? 0, [workspace]);
  const pendingRequests = useMemo(() => workspace?.requests.filter((item) => item.approvalMode === 'always-ask' && (item.status === 'pending' || item.status === 'prepared')) ?? [], [workspace]);
  const terminalRequests = useMemo(() => workspace?.requests.filter((item) => item.approvalMode === 'automatic' || (item.status !== 'pending' && item.status !== 'prepared')).slice(0, 8) ?? [], [workspace]);

  function toggleProduct(product: AgentPolicyInput['products'][number]) {
    setForm((current) => ({
      ...current,
      products: current.products.includes(product) ? current.products.filter((item) => item !== product) : [...current.products, product],
    }));
  }

  function toggleMarket(market: AgentPolicyInput['allowedFuturesMarkets'][number]) {
    setForm((current) => ({
      ...current,
      allowedFuturesMarkets: current.allowedFuturesMarkets.includes(market)
        ? current.allowedFuturesMarkets.filter((item) => item !== market)
        : [...current.allowedFuturesMarkets, market],
    }));
  }

  async function createCredential() {
    if (!auth.authenticated) { auth.login(); return; }
    if (!auth.walletAddress || !auth.identityToken) { setError('Your Privy wallet is still loading.'); return; }
    const needsDelegation = form.approvalMode === 'automatic' && !auth.walletDelegated;
    let delegationNeedsVerification = false;
    setBusy(needsDelegation ? 'delegate' : 'create'); setError(null); setCreated(null);
    try {
      if (form.approvalMode === 'automatic') {
        if (!workspace?.security.automaticExecutionConfigured) {
          throw new Error('Automatic execution is not configured on this Flay deployment. Choose Always ask.');
        }
        if (needsDelegation) {
          delegationNeedsVerification = await waitForAgentDelegation(auth.delegateWalletForAgent()) === 'verification-needed';
          setBusy('create');
        }
      }
      const payload = {
        wallet: auth.walletAddress,
        name: form.name.trim(),
        approvalMode: form.approvalMode,
        products: form.products,
        maxTransactionUsd: Number(form.maxTransactionUsd),
        maxDailyUsd: Number(form.maxDailyUsd),
        maxSlippageBps: Number(form.maxSlippageBps),
        maxFuturesLeverage: Number(form.maxFuturesLeverage),
        maxOpenFuturesPositions: Number(form.maxOpenFuturesPositions),
        allowedTokenMints: splitValues(form.allowedTokenMints),
        allowedStockSymbols: splitValues(form.allowedStockSymbols).map((item) => item.toUpperCase()),
        allowedFuturesMarkets: form.allowedFuturesMarkets,
        expiresInHours: Number(form.expiresInHours),
      };
      const result = await api<AgentCredentialCreated>('/agent/credentials', {
        method: 'POST', identityToken: auth.identityToken, body: JSON.stringify(payload),
      });
      setCreated(result); setCopied(false); await load(true);
    } catch (caught) {
      if (delegationNeedsVerification && caught instanceof ApiClientError && caught.code === 'AGENT_WALLET_NOT_DELEGATED') {
        setError('Privy did not finish granting Full access. Retry once; Flay will never create the credential until Privy confirms this wallet delegation.');
      } else {
        setError(errorMessage(caught));
      }
    } finally {
      setBusy(null);
    }
  }

  async function copyCredential() {
    if (!created) return;
    await navigator.clipboard.writeText(created.credential);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  async function revoke(item: AgentCredentialSummary) {
    if (!auth.walletAddress || !auth.identityToken) return;
    setBusy(`revoke:${item.id}`); setError(null);
    try {
      await api(`/agent/credentials/${item.id}/revoke`, {
        method: 'POST', identityToken: auth.identityToken, body: JSON.stringify({ wallet: auth.walletAddress }),
      });
      await load(true);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(null); }
  }

  async function revokeAutomaticAccess() {
    if (!auth.walletAddress || !auth.identityToken) return;
    setBusy('revoke-delegation'); setError(null);
    try {
      const automatic = workspace?.credentials.filter((item) => item.status === 'active' && item.approvalMode === 'automatic') ?? [];
      for (const item of automatic) {
        await api(`/agent/credentials/${item.id}/revoke`, {
          method: 'POST', identityToken: auth.identityToken, body: JSON.stringify({ wallet: auth.walletAddress }),
        });
      }
      await auth.revokeAgentWalletDelegation();
      await load(true);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(null); }
  }

  async function openReview(item: AgentRequest) {
    if (!auth.walletAddress || !auth.identityToken) return;
    setBusy(`review:${item.id}`); setError(null); setExecution(null);
    try {
      const result = await api<AgentReviewResponse>(`/agent/requests/${item.id}/review`, {
        method: 'POST', identityToken: auth.identityToken, body: JSON.stringify({ wallet: auth.walletAddress }),
      });
      setReview(result); await load(true);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(null); }
  }

  async function reject(item: AgentRequest) {
    if (!auth.walletAddress || !auth.identityToken) return;
    setBusy(`reject:${item.id}`); setError(null);
    try {
      await api(`/agent/requests/${item.id}/reject`, {
        method: 'POST', identityToken: auth.identityToken, body: JSON.stringify({ wallet: auth.walletAddress }),
      });
      if (review?.request.id === item.id) setReview(null);
      await load(true);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(null); }
  }

  async function approveAndExecute() {
    if (!review || !auth.walletAddress || !auth.identityToken) return;
    const item = review.request;
    setBusy(`execute:${item.id}`); setError(null);
    try {
      let result: AgentExecutionResponse;
      if (review.action.type === 'market') {
        const prepared = review.action.prepared;
        const sponsored = prepared.kind === 'market-swap' && prepared.gasPayment?.provider === 'Privy'
          && (prepared.provider === 'raydium' || prepared.provider === 'orca');
        if (sponsored) {
          const venue = prepared.provider === 'raydium' ? 'Raydium' : 'Orca';
          const signature = bs58.encode(await auth.signAndSendSponsoredMarketTransaction(fromBase64(prepared.transaction), venue));
          result = await api<AgentExecutionResponse>(`/agent/requests/${item.id}/complete-sponsored`, {
            method: 'POST', identityToken: auth.identityToken,
            body: JSON.stringify({ wallet: auth.walletAddress, signature }),
          });
        } else {
          const signed = await auth.signTransaction(fromBase64(prepared.transaction));
          result = await api<AgentExecutionResponse>(`/agent/requests/${item.id}/execute`, {
            method: 'POST', identityToken: auth.identityToken,
            body: JSON.stringify({ wallet: auth.walletAddress, signedTransaction: toBase64(signed), idempotencyKey: crypto.randomUUID() }),
          });
        }
      } else {
        const signed = await auth.signTransaction(fromBase64(review.action.prepared.transaction));
        result = await api<AgentExecutionResponse>(`/agent/requests/${item.id}/execute`, {
          method: 'POST', identityToken: auth.identityToken,
          body: JSON.stringify({ wallet: auth.walletAddress, signedTransaction: toBase64(signed), idempotencyKey: crypto.randomUUID() }),
        });
      }
      setExecution(result);
      setReview(null);
      try { onTransactionCompleted?.(result, review); } catch { /* The confirmed server result remains authoritative if local UI reconciliation fails. */ }
      await load(true);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(null); }
  }

  if (!auth.authenticated) {
    return (
      <main className="agent-page agent-auth-state">
        <div className="agent-auth-card"><span><Bot size={27} /></span><p className="agent-kicker">AGENT ACCESS</p><h1>Your wallet stays in charge.</h1><p>Create narrow trading permissions, then choose approval for every request or automatic execution inside those limits.</p><button onClick={auth.login}>Sign in to configure <KeyRound size={16} /></button></div>
      </main>
    );
  }

  return (
    <main className="agent-page">
      <section className="agent-hero">
        <div><p className="agent-kicker"><span /> USER-CONTROLLED AUTOMATION</p><h1>Agent access, <em>with boundaries.</em></h1><p>Let an AI use Convert, xStocks, and Futures under limits you control. Choose approval each time or one-time delegated execution.</p></div>
        <div className="agent-hero-status"><span className="agent-live-dot" /><div><strong>{activeCredentialCount} active agent{activeCredentialCount === 1 ? '' : 's'}</strong><span>{pendingRequests.length} waiting for review</span></div></div>
      </section>

      {error && <div className="agent-error" role="alert"><AlertCircle size={17} /><span>{error}</span><button onClick={() => setError(null)} aria-label="Dismiss"><X size={15} /></button></div>}
      {execution && <div className="agent-success" role="status"><CheckCircle2 size={18} /><div><strong>{execution.result.status === 'confirmed' ? 'Transaction confirmed' : 'Transaction submitted'}</strong><span>{execution.result.status} through {execution.request.execution?.provider} · {short(execution.result.signature, 7)}</span></div><a href={execution.result.explorerUrl} target="_blank" rel="noreferrer">Explorer <ExternalLink size={13} /></a></div>}

      <section className="agent-assurances">
        <div><ShieldCheck size={19} /><span><strong>You choose the approval mode</strong><small>Always ask per trade, or delegate once for automatic execution.</small></span></div>
        <div><LockKeyhole size={19} /><span><strong>No fiat or general wallet access</strong><small>Onramp, send, export, and arbitrary calls have no agent endpoint.</small></span></div>
        <div><Clock3 size={19} /><span><strong>Short-lived requests</strong><small>Unsigned requests expire after 15 minutes.</small></span></div>
      </section>

      <div className="agent-grid">
        <section className="agent-card agent-policy-card">
          <header><div><p className="agent-kicker">NEW CAPABILITY</p><h2>Set the guardrails</h2></div><span className="agent-step">01</span></header>
          <label className="agent-field"><span>Agent name</span><input value={form.name} maxLength={60} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
          <fieldset className="agent-fieldset"><legend>Approval mode</legend><div className="agent-mode-grid">
            <button type="button" className={form.approvalMode === 'always-ask' ? 'selected' : ''} onClick={() => setForm({ ...form, approvalMode: 'always-ask' })}><ShieldCheck size={18} /><span><strong>Always ask</strong><small>Open Flay, review, and approve every action.</small></span></button>
            <button type="button" className={form.approvalMode === 'automatic' ? 'selected' : ''} disabled={workspace ? !workspace.security.automaticExecutionConfigured : true} onClick={() => setForm({ ...form, approvalMode: 'automatic' })}><Zap size={18} /><span><strong>Full access</strong><small>Execute automatically, only inside these guardrails.</small></span></button>
          </div>{workspace && !workspace.security.automaticExecutionConfigured && <small className="agent-mode-note">Automatic mode needs Privy server signing configuration. Always ask is ready now.</small>}</fieldset>
          <fieldset className="agent-fieldset"><legend>Allowed products</legend><div className="agent-choice-row">{(['convert', 'stocks', 'futures'] as const).map((product) => <button type="button" key={product} className={form.products.includes(product) ? 'selected' : ''} onClick={() => toggleProduct(product)}><span>{form.products.includes(product) && <Check size={12} />}</span>{product === 'stocks' ? 'xStocks' : product[0].toUpperCase() + product.slice(1)}</button>)}</div></fieldset>
          <div className="agent-field-grid">
            <label className="agent-field"><span>Per request</span><div className="agent-input-prefix"><i>$</i><input type="number" min="1" value={form.maxTransactionUsd} onChange={(event) => setForm({ ...form, maxTransactionUsd: event.target.value })} /></div></label>
            <label className="agent-field"><span>Rolling 24 hours</span><div className="agent-input-prefix"><i>$</i><input type="number" min="1" value={form.maxDailyUsd} onChange={(event) => setForm({ ...form, maxDailyUsd: event.target.value })} /></div></label>
            <label className="agent-field"><span>Max slippage</span><div className="agent-input-suffix"><input type="number" min="1" max="500" value={form.maxSlippageBps} onChange={(event) => setForm({ ...form, maxSlippageBps: event.target.value })} /><i>bps</i></div></label>
            <label className="agent-field"><span>Capability lifetime</span><div className="agent-input-suffix"><input type="number" min="1" max="720" value={form.expiresInHours} onChange={(event) => setForm({ ...form, expiresInHours: event.target.value })} /><i>hours</i></div></label>
          </div>
          {form.products.includes('convert') && <label className="agent-field"><span>Allowed token mints</span><textarea rows={3} value={form.allowedTokenMints} onChange={(event) => setForm({ ...form, allowedTokenMints: event.target.value })} /><small>Comma-separated Solana mints. SOL, USDC, and JUP are prefilled.</small></label>}
          {form.products.includes('stocks') && <label className="agent-field"><span>Allowed xStocks</span><input value={form.allowedStockSymbols} onChange={(event) => setForm({ ...form, allowedStockSymbols: event.target.value })} /><small>Comma-separated provider symbols.</small></label>}
          {form.products.includes('futures') && <>
            <fieldset className="agent-fieldset"><legend>Allowed futures markets</legend><div className="agent-choice-row">{DEFAULT_MARKETS.map((market) => <button type="button" key={market} className={form.allowedFuturesMarkets.includes(market) ? 'selected' : ''} onClick={() => toggleMarket(market)}><span>{form.allowedFuturesMarkets.includes(market) && <Check size={12} />}</span>{market}</button>)}</div></fieldset>
            <div className="agent-field-grid"><label className="agent-field"><span>Maximum leverage</span><div className="agent-input-suffix"><input type="number" min="1" max="10" value={form.maxFuturesLeverage} onChange={(event) => setForm({ ...form, maxFuturesLeverage: event.target.value })} /><i>×</i></div></label><label className="agent-field"><span>Open position limit</span><input type="number" min="1" max="20" value={form.maxOpenFuturesPositions} onChange={(event) => setForm({ ...form, maxOpenFuturesPositions: event.target.value })} /></label></div>
          </>}
          <button className="agent-primary" disabled={Boolean(busy) || form.products.length === 0} onClick={() => void createCredential()}>{busy === 'delegate' ? <><LoaderCircle className="spin" size={16} /> Authorizing Full access</> : busy === 'create' ? <><LoaderCircle className="spin" size={16} /> Creating secure capability</> : <><KeyRound size={16} /> Create agent credential</>}</button>
          <p className="agent-card-note"><ShieldCheck size={14} /> Flay stores only a SHA-256 hash. The credential is shown once.</p>
        </section>

        <div className="agent-column">
          <section className="agent-card agent-queue-card">
            <header><div><p className="agent-kicker">APPROVAL QUEUE</p><h2>Requests from your agents</h2></div><button className="agent-icon-button" onClick={() => void load()} aria-label="Refresh" disabled={loading}>{loading ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}</button></header>
            {!workspace && loading ? <div className="agent-empty"><LoaderCircle className="spin" size={23} /><p>Loading your controls…</p></div> : pendingRequests.length === 0 ? <div className="agent-empty"><Bot size={25} /><p>No requests need approval.</p><span>Always-ask requests appear here. Automatic actions go directly to recent activity.</span></div> : <div className="agent-request-list">{pendingRequests.map((item) => <article key={item.id} className="agent-request"><div className="agent-request-top"><span className={`agent-status ${statusClass(item.status)}`}>{item.status}</span><time>{formatDate(item.createdAt)}</time></div><h3>{intentTitle(item.intent)}</h3><p>{intentDetail(item.intent)}</p><div className="agent-request-meta"><span>Risk counted <strong>{formatRisk(item.riskUsd)}</strong></span><span>via <strong>{item.credentialName}</strong></span></div>{item.failure && <div className="agent-row-error"><AlertCircle size={13} />{item.failure}</div>}<div className="agent-request-actions"><button className="agent-reject" disabled={Boolean(busy)} onClick={() => void reject(item)}><XCircle size={14} /> Reject</button><button className="agent-review" disabled={Boolean(busy)} onClick={() => void openReview(item)}>{busy === `review:${item.id}` ? <LoaderCircle className="spin" size={14} /> : <ShieldCheck size={14} />} Review exact transaction</button></div></article>)}</div>}
            {terminalRequests.length > 0 && <div className="agent-decisions"><h3>Recent decisions</h3>{terminalRequests.map((item) => <div key={item.id}><span className={`agent-status ${statusClass(item.status)}`}>{item.status}</span><div><strong>{intentTitle(item.intent)}</strong><small>{item.failure ?? `${formatRisk(item.riskUsd)} policy risk · ${formatDate(item.createdAt)}`}</small></div>{item.execution && <a href={item.execution.explorerUrl} target="_blank" rel="noreferrer" aria-label="Open transaction in explorer"><ExternalLink size={14} /></a>}</div>)}</div>}
          </section>

          <section className="agent-card agent-credentials-card">
            <header><div><p className="agent-kicker">ACTIVE ACCESS</p><h2>Capability credentials</h2></div><span>{workspace?.credentials.length ?? 0}</span></header>
            {!workspace?.credentials.length ? <div className="agent-empty compact"><KeyRound size={22} /><p>No agent credentials yet.</p></div> : <div className="agent-credential-list">{workspace.credentials.map((item) => <article key={item.id}><div><strong>{item.name}</strong><span>{item.approvalMode === 'automatic' ? 'Full access' : 'Always ask'} · {item.products.join(' · ')} · expires {formatDate(item.expiresAt)}</span><small>${item.maxTransactionUsd}/request · ${item.maxDailyUsd}/24h · {item.maxSlippageBps} bps{item.products.includes('futures') ? ` · ${item.maxFuturesLeverage}× max` : ''}</small></div><span className={`agent-status ${statusClass(item.status)}`}>{item.status}</span>{item.status === 'active' && <button onClick={() => void revoke(item)} disabled={Boolean(busy)} aria-label={`Revoke ${item.name}`}>{busy === `revoke:${item.id}` ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}</button>}</article>)}</div>}
            {auth.walletDelegated && <button className="agent-delegation-revoke" disabled={Boolean(busy)} onClick={() => void revokeAutomaticAccess()}>{busy === 'revoke-delegation' ? <LoaderCircle className="spin" size={14} /> : <LockKeyhole size={14} />} Revoke automatic wallet access</button>}
          </section>
        </div>
      </div>

      <section className="agent-card agent-audit-card">
        <header><div><p className="agent-kicker">AUDIT TRAIL</p><h2>What happened and when</h2></div><span>Wallet {auth.walletAddress ? short(auth.walletAddress) : '—'}</span></header>
        {!workspace?.events.length ? <div className="agent-empty compact"><Clock3 size={21} /><p>No agent events yet.</p></div> : <div className="agent-audit-list">{workspace.events.slice(0, 12).map((event) => <div key={event.id}><span className={`agent-audit-mark ${event.type.includes('completed') ? 'done' : event.type.includes('failed') || event.type.includes('rejected') || event.type.includes('revoked') ? 'stop' : ''}`} /><div><strong>{event.type.replaceAll('-', ' ')}</strong><p>{event.detail}</p></div><time>{formatDate(event.createdAt)}</time></div>)}</div>}
      </section>

      {created && <div className="agent-modal-backdrop" role="presentation"><section className="agent-modal" role="dialog" aria-modal="true" aria-labelledby="credential-title"><button className="agent-modal-close" onClick={() => setCreated(null)} aria-label="Close"><X size={16} /></button><span className="agent-modal-icon"><KeyRound size={23} /></span><p className="agent-kicker">SHOWN ONCE</p><h2 id="credential-title">Copy the agent credential</h2><p>Give this bearer credential only to the agent you trust. Flay cannot recover it after you close this window. Any standards-compatible MCP client can use the connection below.</p><div className="agent-secret"><code>{created.credential}</code><button onClick={() => void copyCredential()} aria-label="Copy agent credential">{copied ? <Check size={16} /> : <Clipboard size={16} />}</button></div><div className="agent-code-sample"><span>MCP transport · Streamable HTTP</span><code>{`${window.location.origin}/api/mcp`}</code><span>Authorization header</span><code>{`Bearer ${created.credential.slice(0, 28)}…`}</code></div><div className="agent-modal-warning"><LockKeyhole size={16} /><span>{created.summary.approvalMode === 'automatic' ? 'This can execute only the selected trading products inside your guardrails. Fiat, sends, exports, policy changes, and arbitrary programs remain blocked.' : 'This can create approval requests only. It cannot sign, spend, fund with fiat, export keys, or call arbitrary programs.'}</span></div><button className="agent-primary" onClick={() => setCreated(null)}>I saved it securely</button></section></div>}

      {review && <div className="agent-modal-backdrop" role="presentation"><section className="agent-modal agent-review-modal" role="dialog" aria-modal="true" aria-labelledby="review-title"><button className="agent-modal-close" onClick={() => setReview(null)} aria-label="Close"><X size={16} /></button><span className="agent-modal-icon"><ShieldCheck size={23} /></span><p className="agent-kicker">EXACT TRANSACTION REVIEW</p><h2 id="review-title">{intentTitle(review.request.intent)}</h2><p>{intentDetail(review.request.intent)}</p><div className="agent-review-risk"><span>Policy risk counted</span><strong>{formatRisk(review.request.riskUsd)}</strong></div>{review.action.type === 'market' ? <div className="agent-review-table"><div><span>Provider</span><strong>{review.action.prepared.providerLabel}</strong></div><div><span>You pay</span><strong>{review.action.prepared.review.inputAmount && review.action.prepared.review.inputToken ? `${atomicToDecimal(review.action.prepared.review.inputAmount, review.action.prepared.review.inputToken.decimals)} ${review.action.prepared.review.inputToken.symbol}` : '—'}</strong></div><div><span>Minimum received</span><strong>{review.action.prepared.review.minimumOutput && review.action.prepared.review.outputToken ? `${atomicToDecimal(review.action.prepared.review.minimumOutput, review.action.prepared.review.outputToken.decimals)} ${review.action.prepared.review.outputToken.symbol}` : '—'}</strong></div><div><span>Price impact</span><strong>{review.action.prepared.review.priceImpactPct == null ? '—' : `${review.action.prepared.review.priceImpactPct}%`}</strong></div><div><span>Network payment</span><strong>{review.action.prepared.gasPayment?.detail ?? 'Wallet pays the reviewed Solana fee'}</strong></div></div> : <div className="agent-review-table"><div><span>Venue</span><strong>{review.action.prepared.venue}</strong></div><div><span>Action</span><strong>{review.action.prepared.action}</strong></div><div><span>Market</span><strong>{review.action.prepared.review.market ?? '—'}</strong></div><div><span>Collateral</span><strong>{review.action.prepared.review.collateralAtomic ? `${atomicToDecimal(review.action.prepared.review.collateralAtomic, 6)} USDC` : '—'}</strong></div><div><span>Programs checked</span><strong>{review.action.prepared.review.programs.length}</strong></div></div>}{review.action.prepared.review.warnings.length > 0 && <div className="agent-modal-warning"><AlertCircle size={16} /><span>{review.action.prepared.review.warnings.join(' ')}</span></div>}<p className="agent-sign-explainer">This button opens Privy. The agent cannot press it or receive your signature.</p><div className="agent-modal-actions"><button className="agent-reject" disabled={Boolean(busy)} onClick={() => void reject(review.request)}>Reject</button><button className="agent-primary" disabled={Boolean(busy)} onClick={() => void approveAndExecute()}>{busy === `execute:${review.request.id}` ? <><LoaderCircle className="spin" size={16} /> Waiting for Privy</> : <><ShieldCheck size={16} /> Approve in Privy &amp; execute</>}</button></div></section></div>}
    </main>
  );
}
