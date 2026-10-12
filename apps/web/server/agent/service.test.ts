import { describe, expect, it, vi } from 'vitest';
import { SOL_MINT, USDC_MINT } from '../../shared/constants.js';
import type { AgentPolicyInput } from '../../shared/agent.js';
import type { FuturesService } from '../futures/futures-service.js';
import type { FuturesTransactionService } from '../futures/transaction-service.js';
import type { QuoteService } from '../quote-service.js';
import type { StockService } from '../stocks-service.js';
import type { TokenService } from '../tokens.js';
import { AppError } from '../errors.js';
import { AgentService } from './service.js';
import type { AgentDelegatedSigner } from './delegated-signer.js';

const rpcMocks = vi.hoisted(() => ({
  getSignatureStatuses: vi.fn().mockResolvedValue({
    value: [{ slot: 123, confirmations: null, confirmationStatus: 'finalized', err: null }],
  }),
}));

vi.mock('../rpc.js', () => ({
  withRpcFallback: vi.fn(async (operation: (rpc: typeof rpcMocks) => unknown) => operation(rpcMocks)),
}));

function service() {
  const tokens = { getByMint: vi.fn().mockResolvedValue({ mint: USDC_MINT, decimals: 6, usdPrice: 1, verified: true, tradable: true }) };
  const agents = new AgentService(
    tokens as unknown as TokenService,
    {} as QuoteService,
    {} as StockService,
    {} as FuturesService,
    {} as FuturesTransactionService,
  );
  return { agents, tokens };
}

const basePolicy: AgentPolicyInput = {
  name: 'Policy test',
  approvalMode: 'always-ask',
  products: ['convert', 'futures'],
  maxTransactionUsd: 25,
  maxDailyUsd: 30,
  maxSlippageBps: 50,
  maxFuturesLeverage: 3,
  maxOpenFuturesPositions: 2,
  allowedTokenMints: [USDC_MINT, SOL_MINT],
  allowedStockSymbols: [],
  allowedFuturesMarkets: ['SOL-PERP'],
  expiresInHours: 24,
};

function convert(amountAtomic: string, slippageBps = 50) {
  return { kind: 'convert' as const, inputMint: USDC_MINT, outputMint: SOL_MINT, amountAtomic, slippageBps };
}

describe('agent policy enforcement', () => {
  it('rejects product, token, slippage, leverage, and per-request limit violations', async () => {
    const { agents } = service();
    const created = agents.createCredential('user-1', SOL_MINT, basePolicy);

    await expect(agents.submit(created.credential, { idempotencyKey: crypto.randomUUID(), intent: { kind: 'stock', symbol: 'AAPLX', side: 'buy', amount: '1', slippageBps: 50 } }))
      .rejects.toMatchObject({ code: 'AGENT_PRODUCT_DENIED' });
    await expect(agents.submit(created.credential, { idempotencyKey: crypto.randomUUID(), intent: { ...convert('1000000'), outputMint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' } }))
      .rejects.toMatchObject({ code: 'AGENT_TOKEN_DENIED' });
    await expect(agents.submit(created.credential, { idempotencyKey: crypto.randomUUID(), intent: convert('1000000', 100) }))
      .rejects.toMatchObject({ code: 'AGENT_SLIPPAGE_LIMIT' });
    await expect(agents.submit(created.credential, { idempotencyKey: crypto.randomUUID(), intent: { kind: 'futures-open', market: 'SOL-PERP', side: 'long', orderType: 'market', collateralAtomic: '1000000', leverageBps: 40_000, slippageBps: 50, routeChoice: 'auto' } }))
      .rejects.toMatchObject({ code: 'AGENT_LEVERAGE_LIMIT' });
    await expect(agents.submit(created.credential, { idempotencyKey: crypto.randomUUID(), intent: convert('26000000') }))
      .rejects.toMatchObject({ code: 'AGENT_TRANSACTION_LIMIT' });
  });

  it('enforces the rolling daily limit without double-counting idempotent retries', async () => {
    const { agents, tokens } = service();
    const created = agents.createCredential('user-1', SOL_MINT, basePolicy);
    const key = crypto.randomUUID();
    const first = await agents.submit(created.credential, { idempotencyKey: key, intent: convert('20000000') });
    const retry = await agents.submit(created.credential, { idempotencyKey: key, intent: convert('20000000') });
    expect(retry.id).toBe(first.id);
    expect(tokens.getByMint).toHaveBeenCalledTimes(1);
    await expect(agents.submit(created.credential, { idempotencyKey: crypto.randomUUID(), intent: convert('11000000') }))
      .rejects.toMatchObject({ code: 'AGENT_DAILY_LIMIT' });
  });

  it('prepares the next ranked Convert venue when the first venue cannot build', async () => {
    const tokens = { getByMint: vi.fn().mockResolvedValue({ mint: USDC_MINT, decimals: 6, usdPrice: 1, verified: true, tradable: true }) };
    const quotes = {
      quotes: vi.fn().mockResolvedValue({
        bestQuoteId: 'jupiter-quote',
        quotes: [
          { id: 'jupiter-quote', provider: 'jupiter' },
          { id: 'raydium-quote', provider: 'raydium' },
        ],
      }),
      prepare: vi.fn(async (id: string) => {
        if (id === 'jupiter-quote') throw new AppError(400, 'PROVIDER_REJECTED', 'Jupiter: Failed to get quotes');
        return { preparedId: 'raydium-prepared', provider: 'raydium' };
      }),
    };
    const agents = new AgentService(
      tokens as unknown as TokenService,
      quotes as unknown as QuoteService,
      {} as StockService,
      {} as FuturesService,
      {} as FuturesTransactionService,
    );
    const credential = agents.createCredential('user-1', SOL_MINT, basePolicy);
    const submitted = await agents.submit(credential.credential, { idempotencyKey: crypto.randomUUID(), intent: convert('100000') });
    const reviewed = await agents.review('user-1', SOL_MINT, submitted.id);

    expect(quotes.prepare.mock.calls.map(([id]) => id)).toEqual(['jupiter-quote', 'raydium-quote']);
    expect(reviewed.request.status).toBe('prepared');
    expect(reviewed.action).toMatchObject({ type: 'market', prepared: { preparedId: 'raydium-prepared', provider: 'raydium' } });
  });

  it('leaves an exhausted Convert proposal pending for a later retry', async () => {
    const tokens = { getByMint: vi.fn().mockResolvedValue({ mint: USDC_MINT, decimals: 6, usdPrice: 1, verified: true, tradable: true }) };
    const quotes = {
      quotes: vi.fn().mockResolvedValue({
        bestQuoteId: 'jupiter-quote',
        quotes: [
          { id: 'jupiter-quote', provider: 'jupiter' },
          { id: 'orca-quote', provider: 'orca' },
        ],
      }),
      prepare: vi.fn().mockRejectedValue(new AppError(502, 'PROVIDER_UNAVAILABLE', 'Venue unavailable.', true)),
    };
    const agents = new AgentService(
      tokens as unknown as TokenService,
      quotes as unknown as QuoteService,
      {} as StockService,
      {} as FuturesService,
      {} as FuturesTransactionService,
    );
    const credential = agents.createCredential('user-1', SOL_MINT, basePolicy);
    const submitted = await agents.submit(credential.credential, { idempotencyKey: crypto.randomUUID(), intent: convert('100000') });

    await expect(agents.review('user-1', SOL_MINT, submitted.id)).rejects.toMatchObject({
      code: 'AGENT_NO_EXECUTABLE_ROUTE',
      retryable: true,
    });
    const request = agents.workspace('user-1', SOL_MINT).requests.find((item) => item.id === submitted.id);
    expect(request).toMatchObject({ status: 'pending' });
    expect(request?.failure).toContain('No executable Convert route');
    expect(quotes.prepare).toHaveBeenCalledTimes(2);
  });
});

function automaticHarness(options: { sponsored?: boolean; signGate?: Promise<void> } = {}) {
  const tokens = { getByMint: vi.fn().mockResolvedValue({ mint: USDC_MINT, decimals: 6, usdPrice: 1, verified: true, tradable: true }) };
  const prepared = {
    preparedId: 'prepared-auto', kind: 'market-swap' as const,
    provider: options.sponsored ? 'raydium' as const : 'jupiter' as const,
    providerLabel: options.sponsored ? 'Raydium' : 'Jupiter', wallet: SOL_MINT,
    transaction: 'unsigned-transaction', messageHash: 'message-hash', expiresAt: Date.now() + 60_000,
    ...(options.sponsored ? { gasPayment: { mode: 'provider-sponsored' as const, provider: 'Privy' as const, feePayer: null, signatureFeeLamports: null, prioritizationFeeLamports: null, rentFeeLamports: '0', detail: 'Privy pays gas.' } } : {}),
    review: { warnings: [] },
  };
  const result = { signature: 'automatic-signature', status: 'confirmed' as const, explorerUrl: 'https://explorer.invalid/automatic-signature', provider: prepared.providerLabel };
  const quotes = {
    quotes: vi.fn().mockResolvedValue({ bestQuoteId: 'quote-auto', quotes: [{ id: 'quote-auto', provider: prepared.provider }], failures: [] }),
    prepare: vi.fn().mockResolvedValue(prepared),
    execute: vi.fn().mockResolvedValue(result),
    completePrivySponsored: vi.fn().mockResolvedValue({ ...result, gasPayment: prepared.gasPayment }),
  };
  const signer: AgentDelegatedSigner = {
    available: vi.fn().mockReturnValue(true),
    resolveWalletId: vi.fn().mockResolvedValue('delegated-wallet-id'),
    signTransaction: vi.fn(async () => { await options.signGate; return 'signed-transaction'; }),
    signAndSendSponsored: vi.fn(async () => { await options.signGate; return 'automatic-signature'; }),
  };
  const agents = new AgentService(
    tokens as unknown as TokenService,
    quotes as unknown as QuoteService,
    {} as StockService,
    {} as FuturesService,
    {} as FuturesTransactionService,
    signer,
  );
  const policy: AgentPolicyInput = { ...basePolicy, approvalMode: 'automatic', products: ['convert'] };
  const created = agents.createCredential('user-auto', SOL_MINT, policy, 'delegated-wallet-id');
  return { agents, created, quotes, signer };
}

describe('automatic Agent execution', () => {
  it('signs and completes an exact normal provider transaction without UI approval', async () => {
    const { agents, created, quotes, signer } = automaticHarness();
    expect(agents.capability(created.credential)).toMatchObject({ approvalMode: 'automatic', products: ['convert'] });
    const request = await agents.submit(created.credential, { idempotencyKey: crypto.randomUUID(), intent: convert('1000000') });
    expect(request).toMatchObject({ status: 'completed', approvalMode: 'automatic', execution: { signature: 'automatic-signature', provider: 'Jupiter' } });
    expect(signer.signTransaction).toHaveBeenCalledWith('delegated-wallet-id', SOL_MINT, 'unsigned-transaction', expect.stringMatching(/^agent-sign-/));
    expect(quotes.execute).toHaveBeenCalledWith('prepared-auto', 'signed-transaction');

    const status = await agents.requestStatus(created.credential, request.id);
    expect(status).toMatchObject({
      request: { status: 'completed', execution: { signature: 'automatic-signature' } },
      confirmation: { status: 'finalized', slot: 123, error: null },
    });
    expect(rpcMocks.getSignatureStatuses).toHaveBeenCalledWith(['automatic-signature'], { searchTransactionHistory: true });
  });

  it('uses Privy sponsored broadcast and the existing receipt verifier for eligible routes', async () => {
    const { agents, created, quotes, signer } = automaticHarness({ sponsored: true });
    const request = await agents.submit(created.credential, { idempotencyKey: crypto.randomUUID(), intent: convert('1000000') });
    expect(request.status).toBe('completed');
    expect(signer.signAndSendSponsored).toHaveBeenCalledTimes(1);
    expect(signer.signTransaction).not.toHaveBeenCalled();
    expect(quotes.completePrivySponsored).toHaveBeenCalledWith('prepared-auto', 'automatic-signature');
  });

  it('coalesces simultaneous retries and never signs or submits twice', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { agents, created, quotes, signer } = automaticHarness({ signGate: gate });
    const submission = { idempotencyKey: crypto.randomUUID(), intent: convert('1000000') };
    const first = agents.submit(created.credential, submission);
    await vi.waitFor(() => expect(signer.signTransaction).toHaveBeenCalledTimes(1));
    const second = agents.submit(created.credential, submission);
    release();
    const [a, b] = await Promise.all([first, second]);
    const completedReplay = await agents.submit(created.credential, submission);
    expect(a.id).toBe(b.id);
    expect(completedReplay.id).toBe(a.id);
    expect(completedReplay.status).toBe('completed');
    expect(signer.signTransaction).toHaveBeenCalledTimes(1);
    expect(quotes.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps a retryable provider failure pending and completes one later idempotent retry', async () => {
    const { agents, created, quotes, signer } = automaticHarness();
    quotes.prepare
      .mockRejectedValueOnce(new AppError(503, 'PROVIDER_UNAVAILABLE', 'Venue is recovering.', true))
      .mockResolvedValueOnce({
        preparedId: 'prepared-auto', kind: 'market-swap', provider: 'jupiter', providerLabel: 'Jupiter', wallet: SOL_MINT,
        transaction: 'unsigned-transaction', messageHash: 'message-hash', expiresAt: Date.now() + 60_000, review: { warnings: [] },
      });
    const submission = { idempotencyKey: crypto.randomUUID(), intent: convert('1000000') };

    const failedAttempt = await agents.submit(created.credential, submission);
    expect(failedAttempt).toMatchObject({ status: 'pending', failure: expect.stringContaining('No executable Convert route') });
    expect(signer.signTransaction).not.toHaveBeenCalled();

    const recovered = await agents.submit(created.credential, submission);
    expect(recovered).toMatchObject({ id: failedAttempt.id, status: 'completed', execution: { signature: 'automatic-signature' } });
    expect(signer.signTransaction).toHaveBeenCalledTimes(1);
    expect(quotes.execute).toHaveBeenCalledTimes(1);
  });

  it('rechecks revocation after signing and refuses to broadcast', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { agents, created, quotes, signer } = automaticHarness({ signGate: gate });
    const pending = agents.submit(created.credential, { idempotencyKey: crypto.randomUUID(), intent: convert('1000000') });
    await vi.waitFor(() => expect(signer.signTransaction).toHaveBeenCalledTimes(1));
    agents.revoke('user-auto', SOL_MINT, created.summary.id);
    release();
    const request = await pending;
    expect(request).toMatchObject({ status: 'failed', failure: expect.stringContaining('no longer active') });
    expect(quotes.execute).not.toHaveBeenCalled();
  });

  it('fails closed when automatic server signing is unavailable', () => {
    const { agents } = service();
    expect(() => agents.createCredential('user-1', SOL_MINT, { ...basePolicy, approvalMode: 'automatic' }, 'wallet-id'))
      .toThrowError(expect.objectContaining({ code: 'AGENT_AUTOMATIC_NOT_CONFIGURED' }));
  });
});

function automaticProductSigner(): AgentDelegatedSigner {
  return {
    available: vi.fn().mockReturnValue(true),
    resolveWalletId: vi.fn().mockResolvedValue('delegated-wallet-id'),
    signTransaction: vi.fn().mockResolvedValue('signed-transaction'),
    signAndSendSponsored: vi.fn().mockResolvedValue('sponsored-signature'),
  };
}

function venuePortfolio(venue: 'phoenix' | 'gmtrade', options: { position?: boolean; order?: boolean } = {}) {
  return {
    venue,
    available: true,
    collateralAtomic: '10000000',
    withdrawableAtomic: '10000000',
    positions: options.position ? [{ venue, nativeId: 'position-1', market: 'SOL-PERP' }] : [],
    orders: options.order ? [{ venue, nativeId: 'order-1', market: 'SOL-PERP' }] : [],
    orphanedConditionals: [], history: [], error: null, fetchedAt: Date.now(),
  };
}

function futuresPortfolio(options: { position?: boolean; order?: boolean } = {}) {
  return {
    wallet: SOL_MINT, walletSolLamports: '10000000', walletUsdcAtomic: '10000000', walletBalancesStale: false,
    walletBalancesFetchedAt: Date.now(), walletBalancesError: null,
    venues: { phoenix: venuePortfolio('phoenix', options), gmtrade: venuePortfolio('gmtrade') }, fetchedAt: Date.now(),
  };
}

function automaticFuturesHarness(options: { position?: boolean; order?: boolean } = {}) {
  const signer = automaticProductSigner();
  const futures = {
    portfolio: vi.fn().mockResolvedValue(futuresPortfolio(options)),
    routeQuotes: vi.fn().mockResolvedValue({
      recommendedVenue: 'phoenix',
      quotes: [{ id: 'phoenix-route', venue: 'phoenix', market: 'SOL-PERP', executionEligible: true }],
    }),
  };
  const prepared = {
    preparedId: 'futures-prepared', action: 'open', venue: 'phoenix', wallet: SOL_MINT,
    transaction: 'unsigned-futures-transaction', messageHash: 'futures-message-hash', expiresAt: Date.now() + 60_000,
    review: { market: 'SOL-PERP', warnings: [] },
  };
  const futuresTransactions = {
    prepare: vi.fn().mockImplementation(async (input: { action: string }) => ({ ...prepared, action: input.action })),
    execute: vi.fn().mockResolvedValue({
      executionId: 'futures-execution', preparedId: 'futures-prepared', venue: 'phoenix', action: 'open',
      signature: 'futures-signature', status: 'submitted', explorerUrl: 'https://explorer.invalid/futures-signature',
      submittedAt: Date.now(), reconciledAt: null, detail: 'Submitted.',
    }),
  };
  const tokens = { getByMint: vi.fn() };
  const agents = new AgentService(
    tokens as unknown as TokenService,
    {} as QuoteService,
    {} as StockService,
    futures as unknown as FuturesService,
    futuresTransactions as unknown as FuturesTransactionService,
    signer,
  );
  const created = agents.createCredential('user-futures', SOL_MINT, {
    ...basePolicy, approvalMode: 'automatic', products: ['futures'],
  }, 'delegated-wallet-id');
  return { agents, created, signer, futures, futuresTransactions };
}

describe('automatic Agent product execution', () => {
  it('executes an xStocks route through the same prepared market transaction path', async () => {
    const signer = automaticProductSigner();
    const stock = {
      symbol: 'AAPLX', underlyingSymbol: 'AAPL', mint: SOL_MINT, multiplier: { value: '1' },
      requestedDisplayAmount: '2', normalizedInputDisplay: '2', expectedOutputDisplay: '0.01', minimumOutputDisplay: '0.009',
    };
    const stocks = {
      detail: vi.fn().mockResolvedValue({ supportsAtomicSwaps: true, token: { decimals: 8 }, multiplier: { value: '1' }, referencePrice: '200' }),
      quote: vi.fn().mockResolvedValue({ quoteResponse: { bestQuoteId: 'stock-quote', quotes: [{ id: 'stock-quote' }] } }),
    };
    const quotes = {
      prepare: vi.fn().mockResolvedValue({
        preparedId: 'stock-prepared', kind: 'market-swap', provider: 'jupiter', providerLabel: 'Jupiter', wallet: SOL_MINT,
        transaction: 'unsigned-stock-transaction', messageHash: 'stock-message-hash', expiresAt: Date.now() + 60_000,
        review: { stock, warnings: [] },
      }),
      execute: vi.fn().mockResolvedValue({ signature: 'stock-signature', status: 'confirmed', explorerUrl: 'https://explorer.invalid/stock-signature', provider: 'Jupiter' }),
    };
    const agents = new AgentService(
      {} as TokenService,
      quotes as unknown as QuoteService,
      stocks as unknown as StockService,
      {} as FuturesService,
      {} as FuturesTransactionService,
      signer,
    );
    const created = agents.createCredential('user-stock', SOL_MINT, {
      ...basePolicy, approvalMode: 'automatic', products: ['stocks'], allowedStockSymbols: ['AAPLX'],
    }, 'delegated-wallet-id');

    const request = await agents.submit(created.credential, {
      idempotencyKey: crypto.randomUUID(), intent: { kind: 'stock', symbol: 'AAPLX', side: 'buy', amount: '2', slippageBps: 50 },
    });

    expect(request).toMatchObject({
      status: 'completed', execution: { signature: 'stock-signature', marketActivity: { kind: 'Stock', stock: { symbol: 'AAPLX' } } },
    });
    expect(stocks.quote).toHaveBeenCalledWith({ wallet: SOL_MINT, symbol: 'AAPLX', side: 'buy', amount: '2', slippageBps: 50 });
    expect(signer.signTransaction).toHaveBeenCalledTimes(1);
    expect(quotes.execute).toHaveBeenCalledWith('stock-prepared', 'signed-transaction');
  });

  it('automatically opens the aggregator-selected executable Futures route', async () => {
    const { agents, created, signer, futures, futuresTransactions } = automaticFuturesHarness();
    const request = await agents.submit(created.credential, {
      idempotencyKey: crypto.randomUUID(),
      intent: { kind: 'futures-open', market: 'SOL-PERP', side: 'long', orderType: 'market', collateralAtomic: '1000000', leverageBps: 20_000, slippageBps: 50, routeChoice: 'auto' },
    });

    expect(request).toMatchObject({ status: 'completed', execution: { signature: 'futures-signature', provider: 'phoenix' } });
    expect(futures.routeQuotes).toHaveBeenCalledTimes(1);
    expect(futuresTransactions.prepare).toHaveBeenCalledWith(expect.objectContaining({ action: 'open', venue: 'phoenix', quoteId: 'phoenix-route' }));
    expect(signer.signTransaction).toHaveBeenCalledTimes(1);
    expect(futuresTransactions.execute).toHaveBeenCalledWith('futures-prepared', SOL_MINT, 'signed-transaction', expect.stringMatching(/^agent-execute-/));
  });

  it('reserves an in-flight Futures open so concurrent agents cannot exceed the position cap', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { agents, signer, futuresTransactions } = automaticFuturesHarness();
    const limited: AgentPolicyInput = { ...basePolicy, approvalMode: 'automatic', products: ['futures'], maxOpenFuturesPositions: 1 };
    const firstCredential = agents.createCredential('user-futures', SOL_MINT, limited, 'delegated-wallet-id');
    const secondCredential = agents.createCredential('user-futures', SOL_MINT, limited, 'delegated-wallet-id');
    vi.mocked(signer.signTransaction).mockImplementation(async () => { await gate; return 'signed-transaction'; });
    const intent = { kind: 'futures-open' as const, market: 'SOL-PERP' as const, side: 'long' as const, orderType: 'market' as const, collateralAtomic: '1000000', leverageBps: 20_000, slippageBps: 50, routeChoice: 'auto' as const };

    const first = agents.submit(firstCredential.credential, { idempotencyKey: crypto.randomUUID(), intent });
    await vi.waitFor(() => expect(signer.signTransaction).toHaveBeenCalledTimes(1));
    await expect(agents.submit(secondCredential.credential, { idempotencyKey: crypto.randomUUID(), intent }))
      .rejects.toMatchObject({ code: 'AGENT_POSITION_LIMIT' });
    release();
    await expect(first).resolves.toMatchObject({ status: 'completed' });
    expect(futuresTransactions.execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['close', { position: true }, 'position-1'],
    ['cancel', { order: true }, 'order-1'],
  ] as const)('automatically executes a verified Futures %s target', async (action, portfolioOptions, nativeId) => {
    const { agents, created, futuresTransactions } = automaticFuturesHarness(portfolioOptions);
    const request = await agents.submit(created.credential, {
      idempotencyKey: crypto.randomUUID(),
      intent: { kind: 'futures-manage', action, venue: 'phoenix', market: 'SOL-PERP', nativeId },
    });

    expect(request.status).toBe('completed');
    expect(futuresTransactions.prepare).toHaveBeenCalledWith(expect.objectContaining({ action, venue: 'phoenix', nativeId, market: 'SOL-PERP' }));
    expect(futuresTransactions.execute).toHaveBeenCalledTimes(1);
  });
});
