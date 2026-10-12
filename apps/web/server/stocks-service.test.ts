import { PublicKey } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { USDC_MINT } from '../shared/constants.js';
import { AppError } from './errors.js';
import type { QuoteResponse, StockAsset, TokenInfo } from '../shared/types.js';
import { StockService } from './stocks-service.js';
import { stockPricesSchema, stockQuoteSchema } from './schemas.js';

const STOCK_MINT = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
const WALLET = new PublicKey(new Uint8Array(32).fill(9)).toBase58();
const usdc: TokenInfo = { mint: USDC_MINT, symbol: 'USDC', name: 'USD Coin', decimals: 6, logoUri: null, tokenProgram: 'spl-token', verified: true, tags: [], extensions: [], tradable: true, blockedReason: null, usdPrice: 1 };
const stock: TokenInfo = { mint: STOCK_MINT, symbol: 'AAPLx', name: 'Apple xStock', decimals: 6, logoUri: null, tokenProgram: 'token-2022', verified: true, tags: ['xstocks'], extensions: ['ScaledUiAmountConfig'], tradable: true, blockedReason: null, usdPrice: 200 };

function assetPayload(mint = STOCK_MINT) {
  return {
    name: 'Apple xStock', symbol: 'AAPLx', underlyingSymbol: 'AAPL', description: 'Apple xStock', logo: 'https://example.com/aapl.png', isTradingHalted: false,
    trading: { currency: 'USD', tradingHoursMode: 'TwentyFourFive', currentPeriod: 'market', openNow: true, nextChangeAt: '2026-09-25T00:00:00.000Z', exchange: { abbreviation: 'NASDAQ' } },
    deployments: [{ address: mint, network: 'Solana', supportsAtomicSwaps: true }],
  };
}

function response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}

function mockProviders(mint = STOCK_MINT) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.endsWith('/price-data')) return response({ quote: 200 });
    if (url.pathname.endsWith('/multiplier')) return response({ currentMultiplier: 1.25, newMultiplier: 1.5, activationDateTime: 1_800_000_000_000, reason: 'split' });
    if (url.pathname.endsWith('/AAPLx')) return response(assetPayload(mint));
    const page = Number(url.searchParams.get('page') ?? '0');
    return response({ nodes: page === 0 ? [assetPayload(mint)] : [], page: { currentPage: page, hasNextPage: false } });
  });
}

function services() {
  const tokens = {
    getByMint: vi.fn(async (mint: string) => mint === USDC_MINT ? usdc : stock),
    getOfficialStockByMint: vi.fn(async () => stock),
  };
  const quotes = {
    quotes: vi.fn(async (request: { inputMint: string; outputMint: string; amount: string; slippageBps: number }, options: { providers: string[]; stock: { multiplier: { value: string } } }): Promise<QuoteResponse> => {
      if (options.providers[0] !== 'jupiter') throw new Error('Stocks must use Jupiter only.');
      return ({
      inputToken: request.inputMint === USDC_MINT ? usdc : stock,
      outputToken: request.outputMint === USDC_MINT ? usdc : stock,
      quotes: [{ id: 'quote', provider: 'jupiter', providerLabel: 'Jupiter Swap V2', routeLabel: 'Raydium CLMM', inputMint: request.inputMint, outputMint: request.outputMint, inAmount: request.amount, outAmount: request.outputMint === STOCK_MINT ? '500000' : '10000000', minimumOut: request.outputMint === STOCK_MINT ? '490000' : '9900000', slippageBps: request.slippageBps, priceImpactPct: 0.1, fees: [], networkFeeLamports: null, fetchedAt: Date.now(), expiresAt: Date.now() + 15_000, poolIds: [], warnings: [] }],
      failures: [], bestQuoteId: 'quote', requestedAt: Date.now(),
      } satisfies QuoteResponse);
    }),
  };
  return { tokens, quotes, service: new StockService(tokens as never, quotes as never) };
}

afterEach(() => vi.unstubAllGlobals());

describe('StockService trust boundary', () => {
  it('returns an official initial asset and starts the complete Solana directory in the background', async () => {
    const provider = mockProviders();
    vi.stubGlobal('fetch', provider);
    const { service } = services();
    const [first, coalesced] = await Promise.all([service.catalog(), service.catalog()]);
    const second = await service.catalog();
    expect(first.assets).toHaveLength(1);
    expect(first.assets[0]).toMatchObject({ symbol: 'AAPLx', mint: STOCK_MINT });
    expect(second.status).toBe('live');
    expect(coalesced.assets).toEqual(first.assets);
    expect(first.directoryComplete).toBe(false);
    expect(first.warning).toMatch(/full official xStocks directory/i);
    expect(String(provider.mock.calls[0]?.[0])).toMatch(/\/public\/assets\/AAPLx$/);
    const catalogUrls = provider.mock.calls
      .map(([input]) => new URL(input instanceof Request ? input.url : input.toString()))
      .filter((url) => url.pathname.endsWith('/public/assets'));
    expect(catalogUrls.length).toBeLessThanOrEqual(4);
    for (const [page, url] of catalogUrls.entries()) {
      expect(url.searchParams.get('network')).toBe('Solana');
      expect(url.searchParams.get('page')).toBe(String(page));
      expect(url.searchParams.get('pageSize')).toBe('100');
    }
  });

  it('waits for the complete official directory when an agent requests discovery', async () => {
    const provider = mockProviders();
    vi.stubGlobal('fetch', provider);
    const { service } = services();

    const catalog = await service.completeCatalog();

    expect(catalog).toMatchObject({ status: 'live', directoryComplete: true, warning: null });
    expect(catalog.assets).toHaveLength(1);
    expect(provider.mock.calls.some(([input]) => new URL(input instanceof Request ? input.url : input.toString()).pathname.endsWith('/public/assets'))).toBe(true);
  });

  it('does not double a failed initial catalog request with an automatic retry', async () => {
    const timeout = Object.assign(new Error('slow provider'), { name: 'AbortError' });
    const provider = vi.fn().mockRejectedValue(timeout);
    vi.stubGlobal('fetch', provider);
    const { service } = services();
    await expect(service.catalog()).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('keeps verified detail usable when only the optional issuer price times out', async () => {
    const fallback = mockProviders();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.endsWith('/price-data')) {
        throw Object.assign(new Error('slow reference price'), { name: 'AbortError' });
      }
      return fallback(input);
    }));
    const { service } = services();
    const asset = await service.detail('AAPLx');
    expect(asset).toMatchObject({
      symbol: 'AAPLx',
      mint: STOCK_MINT,
      referencePrice: null,
      referencePriceFetchedAt: null,
      multiplier: { value: '1.25' },
      token: { mint: STOCK_MINT, tokenProgram: 'token-2022' },
    });
  });

  it('uses a live Jupiter market price for canonical assets when issuer pricing times out', async () => {
    const fallback = mockProviders();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname === 'api.jup.ag' && url.pathname === '/price/v3') {
        expect(url.searchParams.get('ids')).toBe(STOCK_MINT);
        return response({ [STOCK_MINT]: { stockData: { price: 201.25 }, usdPrice: 200.75 } });
      }
      if (url.pathname.endsWith('/price-data')) throw Object.assign(new Error('slow issuer price'), { name: 'AbortError' });
      return fallback(input);
    }));
    const { service } = services();
    const asset = await service.detail('AAPLx');
    expect(asset).toMatchObject({ referencePrice: '201.25', referencePriceSource: 'jupiter', token: { usdPrice: 201.25 } });
    const prices = await service.referencePrices(['AAPLx']);
    expect(prices.prices.AAPLX).toMatchObject({ value: '201.25', source: 'jupiter' });
  });

  it('returns prices for every one of the twelve visible official assets in one Jupiter batch', async () => {
    const assets: StockAsset[] = Array.from({ length: 12 }, (_, index) => {
      const number = index + 1;
      return {
        symbol: `STK${number}x`,
        underlyingSymbol: `STK${number}`,
        name: `Stock ${number} xStock`,
        description: `Stock ${number} xStock`,
        logoUri: null,
        mint: new PublicKey(new Uint8Array(32).fill(number)).toBase58(),
        currency: 'USD',
        exchange: 'NASDAQ',
        tradingHoursMode: 'TwentyFourFive',
        tradingPeriod: 'market',
        openNow: true,
        nextTradingChangeAt: null,
        isTradingHalted: false,
        supportsAtomicSwaps: true,
        referencePrice: null,
        referencePriceSource: null,
        referencePriceFetchedAt: null,
        multiplier: null,
        token: null,
      };
    });
    const provider = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname === 'api.jup.ag' && url.pathname === '/price/v3') {
        const mints = (url.searchParams.get('ids') ?? '').split(',');
        expect(mints).toEqual(assets.map((asset) => asset.mint));
        return response(Object.fromEntries(assets.map((asset, index) => [asset.mint, { stockData: { price: index + 100 } }])));
      }
      if (url.pathname.endsWith('/price-data')) throw Object.assign(new Error('issuer unavailable'), { name: 'AbortError' });
      throw new Error(`Unexpected provider request: ${url}`);
    });
    vi.stubGlobal('fetch', provider);
    const { service } = services();
    (service as unknown as { catalogCache: { assets: StockAsset[]; directoryComplete: boolean; fetchedAt: number; expiresAt: number } }).catalogCache = {
      assets,
      directoryComplete: true,
      fetchedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };

    const result = await service.referencePrices(assets.map((asset) => asset.symbol));

    expect(Object.keys(result.prices)).toHaveLength(12);
    expect(result.prices.STK12X).toMatchObject({ value: '111', source: 'jupiter' });
    expect(provider.mock.calls.filter(([input]) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return url.hostname === 'api.jup.ag' && url.pathname === '/price/v3';
    })).toHaveLength(1);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('prefers the official issuer price when both price sources respond', async () => {
    const provider = mockProviders();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname === 'api.jup.ag' && url.pathname === '/price/v3') return response({ [STOCK_MINT]: { stockData: { price: 201.25 } } });
      return provider(input);
    }));
    const { service } = services();
    const asset = await service.detail('AAPLx');
    expect(asset).toMatchObject({ referencePrice: '200', referencePriceSource: 'xstocks', token: { usdPrice: 200 } });
  });

  it('shows a verified issuer asset but blocks trading while on-chain verification is unavailable', async () => {
    vi.stubGlobal('fetch', mockProviders());
    const { service, tokens } = services();
    tokens.getOfficialStockByMint.mockRejectedValue(new AppError(503, 'RPC_UNAVAILABLE', 'Solana RPC is unavailable.', true));
    const asset = await service.detail('AAPLx');
    expect(asset).toMatchObject({ symbol: 'AAPLx', mint: STOCK_MINT, token: null });
    await expect(service.quote({ wallet: WALLET, symbol: 'AAPLx', side: 'buy', amount: '10', slippageBps: 50 }))
      .rejects.toMatchObject({ code: 'XSTOCKS_DETAIL_UNAVAILABLE' });
  });

  it('marks a recent catalog as browse-only stale when refresh fails', async () => {
    vi.stubGlobal('fetch', mockProviders());
    const { service } = services();
    await service.catalog();
    (service as unknown as { catalogCache: { expiresAt: number } }).catalogCache.expiresAt = 0;
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    const stale = await service.catalog();
    expect(stale.status).toBe('stale');
    expect(stale.warning).toMatch(/new stock trades are disabled/i);
  });

  it('binds buys to native USDC, canonical stock mint, and Jupiter only', async () => {
    vi.stubGlobal('fetch', mockProviders());
    const { service, quotes } = services();
    const result = await service.quote({ wallet: WALLET, symbol: 'AAPLx', side: 'buy', amount: '10', slippageBps: 50 });
    expect(quotes.quotes).toHaveBeenCalledWith(expect.objectContaining({
      inputMint: USDC_MINT,
      outputMint: STOCK_MINT,
      amount: '10000000',
      executionWallet: WALLET,
      jupiterMode: 'router',
    }), expect.objectContaining({ providers: ['jupiter'] }));
    expect(result.trade.expectedOutputDisplay).toBe('0.625');
    expect(result.trade.minimumOutputDisplay).toBe('0.6125');
  });

  it('converts scaled sell shares to raw input before Jupiter quoting', async () => {
    vi.stubGlobal('fetch', mockProviders());
    const { service, quotes } = services();
    const result = await service.quote({ wallet: WALLET, symbol: 'AAPLx', side: 'sell', amount: '1', slippageBps: 50 });
    expect(quotes.quotes).toHaveBeenCalledWith(expect.objectContaining({ inputMint: STOCK_MINT, outputMint: USDC_MINT, amount: '800000' }), expect.anything());
    expect(result.trade.normalizedInputDisplay).toBe('1');
  });

  it('retries one retryable Jupiter failure and returns the recovered stock route', async () => {
    vi.stubGlobal('fetch', mockProviders());
    const { service, quotes } = services();
    const live = await quotes.quotes({ inputMint: STOCK_MINT, outputMint: USDC_MINT, amount: '800000', slippageBps: 50 }, { providers: ['jupiter'], stock: { multiplier: { value: '1.25' } } });
    quotes.quotes.mockClear();
    quotes.quotes
      .mockResolvedValueOnce({ ...live, quotes: [], failures: [{ provider: 'jupiter', code: 'PROVIDER_TIMEOUT', message: 'Jupiter took too long.', retryable: true }], bestQuoteId: null })
      .mockResolvedValueOnce(live);

    const result = await service.quote({ wallet: WALLET, symbol: 'AAPLx', side: 'sell', amount: '1', slippageBps: 50 });

    expect(quotes.quotes).toHaveBeenCalledTimes(2);
    expect(result.trade.expectedOutputDisplay).toBe('10');
    expect(result.quoteResponse.quotes).toHaveLength(1);
  });

  it('propagates the real Jupiter failure after one bounded retry', async () => {
    vi.stubGlobal('fetch', mockProviders());
    const { service, quotes } = services();
    const failed: QuoteResponse = {
      inputToken: stock,
      outputToken: usdc,
      quotes: [],
      failures: [{ provider: 'jupiter', code: 'PROVIDER_TIMEOUT', message: 'Jupiter Router did not respond in time.', retryable: true }],
      bestQuoteId: null,
      requestedAt: Date.now(),
    };
    quotes.quotes.mockResolvedValue(failed);

    await expect(service.quote({ wallet: WALLET, symbol: 'AAPLx', side: 'sell', amount: '1', slippageBps: 50 }))
      .rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT', message: 'Jupiter Router did not respond in time.', retryable: true });
    expect(quotes.quotes).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-retryable stock route failure', async () => {
    vi.stubGlobal('fetch', mockProviders());
    const { service, quotes } = services();
    quotes.quotes.mockResolvedValue({
      inputToken: stock,
      outputToken: usdc,
      quotes: [],
      failures: [{ provider: 'jupiter', code: 'SOLANA_SIMULATION_FAILED', message: 'The exact stock transaction cannot execute.', retryable: false }],
      bestQuoteId: null,
      requestedAt: Date.now(),
    });

    await expect(service.quote({ wallet: WALLET, symbol: 'AAPLx', side: 'sell', amount: '1', slippageBps: 50 }))
      .rejects.toMatchObject({ code: 'SOLANA_SIMULATION_FAILED', status: 422, retryable: false });
    expect(quotes.quotes).toHaveBeenCalledTimes(1);
  });

  it('fails closed when asset detail changes the official mint', async () => {
    const conflictingMint = new PublicKey(new Uint8Array(32).fill(8)).toBase58();
    const provider = mockProviders(conflictingMint);
    let catalogServed = false;
    let aaplRequests = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.endsWith('/public/assets/AAPLx')) {
        aaplRequests += 1;
        return response(assetPayload(aaplRequests === 1 ? STOCK_MINT : conflictingMint));
      }
      if (url.pathname.endsWith('/public/assets') && !catalogServed) {
        catalogServed = true;
        return response({ nodes: [assetPayload(STOCK_MINT)], page: { currentPage: 0, hasNextPage: false } });
      }
      return provider(input);
    }));
    const { service } = services();
    await expect(service.detail('AAPLx')).rejects.toMatchObject({ code: 'XSTOCKS_MINT_MISMATCH' });
  });

  it('keeps an unvalidated symbol unavailable while the official directory loads', async () => {
    vi.stubGlobal('fetch', mockProviders());
    const { service } = services();
    await expect(service.quote({ wallet: WALLET, symbol: 'FAKEx', side: 'buy', amount: '10', slippageBps: 50 }))
      .rejects.toMatchObject({ code: 'XSTOCKS_DIRECTORY_LOADING' });
  });
});

describe('stock quote schema', () => {
  it('accepts twelve price symbols and rejects a thirteenth', () => {
    const twelve = Array.from({ length: 12 }, (_, index) => `STK${index + 1}x`).join(',');
    const thirteen = `${twelve},STK13x`;
    expect(stockPricesSchema.parse({ symbols: twelve }).symbols).toHaveLength(12);
    expect(() => stockPricesSchema.parse({ symbols: thirteen })).toThrow();
  });

  it('accepts bounded buy and sell requests', () => {
    expect(stockQuoteSchema.parse({ wallet: WALLET, symbol: 'AAPLx', side: 'buy', amount: '0.58', slippageBps: 50 }).side).toBe('buy');
    expect(stockQuoteSchema.parse({ wallet: WALLET, symbol: 'BRK.Bx', side: 'sell', amount: '0.00000001', slippageBps: 100 }).side).toBe('sell');
  });

  it('rejects scientific notation, arbitrary symbols, and excess precision', () => {
    expect(() => stockQuoteSchema.parse({ wallet: WALLET, symbol: 'AAPL/x', side: 'buy', amount: '1', slippageBps: 50 })).toThrow();
    expect(() => stockQuoteSchema.parse({ wallet: WALLET, symbol: 'AAPLx', side: 'buy', amount: '1e3', slippageBps: 50 })).toThrow();
    expect(() => stockQuoteSchema.parse({ wallet: WALLET, symbol: 'AAPLx', side: 'sell', amount: '0.1234567890123456789', slippageBps: 50 })).toThrow();
  });
});
