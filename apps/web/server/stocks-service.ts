import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { atomicToDecimal, decimalToAtomic } from '../shared/amounts.js';
import { USDC_MINT } from '../shared/constants.js';
import { normalizeMultiplier, scaledAtomicToDecimal, scaledDecimalToAtomic } from '../shared/stock-amounts.js';
import type {
  StockAsset,
  StockCatalogResponse,
  StockQuoteResponse,
  StockTradeContext,
  StockTradeSide,
} from '../shared/types.js';
import { config, providerHeaders } from './config.js';
import { AppError } from './errors.js';
import { fetchJson } from './fetch-json.js';
import type { QuoteOptions, QuoteService } from './quote-service.js';
import type { TokenService } from './tokens.js';

const MAX_CATALOG_PAGES = 16;
const MAX_CATALOG_ASSETS = 1_600;
const STALE_CATALOG_MS = 24 * 60 * 60_000;
// xStocks can throttle large concurrent catalog bursts. Four bounded requests
// preserve pagination throughput without turning one provider pause into eight
// simultaneous timeouts.
const PAGE_BATCH_SIZE = 4;
const CATALOG_PAGE_SIZE = 100;
// The directory renders twelve rows at a time, and the request schema permits
// the same bounded amount. Keep this ceiling aligned so visible, verified
// assets do not silently lose their price while still using one provider batch.
const MAX_REFERENCE_PRICE_SYMBOLS = 12;
const STOCK_QUOTE_RETRY_DELAY_MS = 250;

const boundedText = z.string().min(1).max(300);
const nullableText = z.string().max(300).nullable().optional();
const deploymentSchema = z.object({
  address: z.string().min(32).max(64),
  network: z.string().min(1).max(40),
  supportsAtomicSwaps: z.boolean().optional().default(false),
}).passthrough();
const assetSchema = z.object({
  name: boundedText,
  symbol: z.string().min(2).max(24).regex(/^[A-Za-z0-9.]+$/),
  underlyingSymbol: z.string().min(1).max(24),
  description: nullableText,
  logo: z.string().url().max(500).nullable().optional(),
  isTradingHalted: z.boolean().optional().default(false),
  trading: z.object({
    currency: z.string().min(3).max(10).optional().default('USD'),
    tradingHoursMode: nullableText,
    currentPeriod: nullableText,
    openNow: z.boolean().nullable().optional(),
    nextChangeAt: z.string().datetime().nullable().optional(),
    exchange: z.object({
      abbreviation: z.string().max(40).nullable().optional(),
      name: z.string().max(120).nullable().optional(),
    }).passthrough().nullable().optional(),
  }).passthrough().nullable().optional(),
  deployments: z.array(deploymentSchema).max(30),
}).passthrough();
const catalogPageSchema = z.object({
  nodes: z.array(assetSchema).max(100),
  page: z.object({
    currentPage: z.number().int().min(0).max(MAX_CATALOG_PAGES + 10),
    hasNextPage: z.boolean(),
  }),
});
const priceSchema = z.object({
  quote: z.number().finite().positive().max(1_000_000_000),
});
const multiplierSchema = z.object({
  currentMultiplier: z.number().finite().positive().max(1_000_000),
  newMultiplier: z.number().finite().min(0).max(1_000_000),
  activationDateTime: z.number().finite().min(0),
  reason: z.string().max(300).nullable(),
});

interface CatalogCache {
  assets: StockAsset[];
  directoryComplete: boolean;
  fetchedAt: number;
  expiresAt: number;
}

interface DetailCache {
  asset: StockAsset;
  expiresAt: number;
}

type ReferencePrice = { value: string; source: 'xstocks' | 'jupiter' };

function safeLogo(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function canonicalSymbol(value: string): string {
  const symbol = value.trim();
  if (!/^[A-Za-z0-9.]{2,24}$/.test(symbol)) throw new AppError(400, 'XSTOCKS_SYMBOL_INVALID', 'Choose a valid xStocks symbol.');
  return symbol.toUpperCase();
}

async function fetchXstocks(
  url: URL,
  maxBytes: number,
  { timeoutMs = config.xstocksTimeoutMs, retry = true }: { timeoutMs?: number; retry?: boolean } = {},
): Promise<unknown> {
  const options = {
    provider: 'xStocks',
    timeoutMs,
    maxBytes,
    headers: { accept: 'application/json', 'user-agent': 'Flay-Stocks/0.1' },
  } as const;
  try {
    return await fetchJson<unknown>(url, options);
  } catch (error) {
    if (!retry || !(error instanceof AppError) || !error.retryable) throw error;
    await new Promise((resolve) => setTimeout(resolve, 250));
    return fetchJson<unknown>(url, options);
  }
}

function normalizeAsset(row: z.infer<typeof assetSchema>): StockAsset | null {
  const deployment = row.deployments.find((candidate) => candidate.network.toLowerCase() === 'solana');
  if (!deployment) return null;
  try {
    if (new PublicKey(deployment.address).toBase58() !== deployment.address) return null;
  } catch {
    return null;
  }
  const exchange = row.trading?.exchange?.abbreviation ?? row.trading?.exchange?.name ?? null;
  return {
    symbol: row.symbol,
    underlyingSymbol: row.underlyingSymbol,
    name: row.name,
    description: row.description ?? row.name,
    logoUri: safeLogo(row.logo),
    mint: deployment.address,
    currency: row.trading?.currency ?? 'USD',
    exchange,
    tradingHoursMode: row.trading?.tradingHoursMode ?? null,
    tradingPeriod: row.trading?.currentPeriod ?? null,
    openNow: row.trading?.openNow ?? null,
    nextTradingChangeAt: row.trading?.nextChangeAt ?? null,
    isTradingHalted: row.isTradingHalted,
    supportsAtomicSwaps: deployment.supportsAtomicSwaps,
    referencePrice: null,
    referencePriceSource: null,
    referencePriceFetchedAt: null,
    multiplier: null,
    token: null,
  };
}

export class StockService {
  private catalogCache: CatalogCache | null = null;
  private catalogInflight: Promise<CatalogCache> | null = null;
  private initialCatalogInflight: Promise<CatalogCache> | null = null;
  private readonly details = new Map<string, DetailCache>();
  private readonly detailInflight = new Map<string, Promise<StockAsset>>();
  private readonly prices = new Map<string, ReferencePrice & { fetchedAt: number; expiresAt: number }>();

  constructor(
    private readonly tokens: TokenService,
    private readonly quotes: QuoteService,
  ) {}

  async catalog(requireFresh = false): Promise<StockCatalogResponse> {
    const now = Date.now();
    if (this.catalogCache && this.catalogCache.expiresAt > now) {
      if (!this.catalogCache.directoryComplete) void this.loadCatalogCoalesced().catch(() => undefined);
      return this.catalogResponse(this.catalogCache, 'live', this.catalogWarning(this.catalogCache));
    }
    try {
      const loaded = await this.loadInitialCatalogCoalesced();
      return this.catalogResponse(loaded, 'live', this.catalogWarning(loaded));
    } catch (error) {
      if (!requireFresh && this.catalogCache && now - this.catalogCache.fetchedAt <= STALE_CATALOG_MS) {
        return this.catalogResponse(this.catalogCache, 'stale', 'xStocks is temporarily unavailable. Browse-only cached assets are shown; new stock trades are disabled.');
      }
      throw error;
    }
  }

  async completeCatalog(): Promise<StockCatalogResponse> {
    const cached = this.catalogCache;
    if (cached?.directoryComplete && cached.expiresAt > Date.now()) {
      return this.catalogResponse(cached, 'live', null);
    }
    const loaded = await this.loadCatalogCoalesced();
    if (!loaded.directoryComplete) {
      throw new AppError(503, 'XSTOCKS_DIRECTORY_INCOMPLETE', 'The complete official xStocks directory is not available yet. Retry shortly.', true);
    }
    return this.catalogResponse(loaded, 'live', null);
  }

  async detail(symbolInput: string, requireFresh = false): Promise<StockAsset> {
    const symbol = canonicalSymbol(symbolInput);
    const catalog = await this.catalog(requireFresh);
    if (requireFresh && catalog.status !== 'live') {
      throw new AppError(503, 'XSTOCKS_DATA_STALE', 'Fresh xStocks data is required before requesting an executable route.', true);
    }
    const official = catalog.assets.find((asset) => asset.symbol.toUpperCase() === symbol);
    if (!official) {
      if (!catalog.directoryComplete) {
        throw new AppError(503, 'XSTOCKS_DIRECTORY_LOADING', 'The official xStocks directory is still loading. Retry shortly.', true);
      }
      throw new AppError(404, 'XSTOCKS_ASSET_NOT_FOUND', 'That symbol has no official Solana xStocks deployment.');
    }
    const cached = this.details.get(symbol);
    if (cached && cached.expiresAt > Date.now()) return cached.asset;
    const running = this.detailInflight.get(symbol);
    if (running) return running;
    const promise = this.loadDetail(official).finally(() => this.detailInflight.delete(symbol));
    this.detailInflight.set(symbol, promise);
    return promise;
  }

  async quote(input: {
    wallet: string;
    symbol: string;
    side: StockTradeSide;
    amount: string;
    slippageBps: number;
  }): Promise<StockQuoteResponse> {
    const asset = await this.detail(input.symbol, true);
    if (asset.isTradingHalted) throw new AppError(409, 'XSTOCKS_TRADING_HALTED', `${asset.symbol} is currently halted by the issuer.`);
    if (!asset.multiplier || !asset.token) throw new AppError(503, 'XSTOCKS_DETAIL_UNAVAILABLE', 'Fresh xStocks token detail is unavailable.', true);

    const usdc = await this.tokens.getByMint(USDC_MINT);
    let amountAtomic: string;
    let normalizedInputDisplay: string;
    if (input.side === 'buy') {
      amountAtomic = decimalToAtomic(input.amount, usdc.decimals);
      if (BigInt(amountAtomic) <= 0n) throw new AppError(400, 'XSTOCKS_AMOUNT_DUST', 'Enter a USDC amount above zero.');
      normalizedInputDisplay = atomicToDecimal(amountAtomic, usdc.decimals);
    } else {
      try {
        const converted = scaledDecimalToAtomic(input.amount, asset.token.decimals, asset.multiplier.value);
        amountAtomic = converted.amountAtomic;
        normalizedInputDisplay = converted.normalizedDisplayAmount;
      } catch (error) {
        throw new AppError(400, 'XSTOCKS_AMOUNT_INVALID', error instanceof Error ? error.message : 'Enter a valid stock amount.');
      }
    }

    const inputToken = input.side === 'buy' ? usdc : asset.token;
    const outputToken = input.side === 'buy' ? asset.token : usdc;
    const trade: StockTradeContext = {
      side: input.side,
      symbol: asset.symbol,
      underlyingSymbol: asset.underlyingSymbol,
      mint: asset.mint,
      multiplier: asset.multiplier,
      requestedDisplayAmount: input.amount,
      normalizedInputDisplay,
      expectedOutputDisplay: '',
      minimumOutputDisplay: '',
      referencePrice: asset.referencePrice,
      referencePriceFetchedAt: asset.referencePriceFetchedAt,
    };
    const quoteRequest = {
      inputMint: inputToken.mint,
      outputMint: outputToken.mint,
      amount: amountAtomic,
      slippageBps: input.slippageBps,
      executionWallet: input.wallet,
      jupiterMode: 'router' as const,
    };
    const quoteOptions: QuoteOptions = {
      providers: ['jupiter'],
      inputToken,
      outputToken,
      stock: trade,
    };
    let quoteResponse = await this.quotes.quotes(quoteRequest, quoteOptions);
    if (!quoteResponse.quotes.length && quoteResponse.failures.some((failure) => failure.retryable)) {
      await new Promise((resolve) => setTimeout(resolve, STOCK_QUOTE_RETRY_DELAY_MS));
      quoteResponse = await this.quotes.quotes(quoteRequest, quoteOptions);
    }
    const best = quoteResponse.quotes.find((quote) => quote.id === quoteResponse.bestQuoteId) ?? quoteResponse.quotes[0];
    if (!best) {
      const failure = quoteResponse.failures[0];
      throw new AppError(
        failure?.retryable === false ? 422 : 503,
        failure?.code ?? 'XSTOCKS_ROUTE_UNAVAILABLE',
        failure?.message ?? 'Jupiter did not return an executable stock route. Retry shortly.',
        failure?.retryable ?? true,
      );
    }
    trade.expectedOutputDisplay = input.side === 'buy'
      ? scaledAtomicToDecimal(best.outAmount, asset.token.decimals, asset.multiplier.value)
      : atomicToDecimal(best.outAmount, usdc.decimals);
    trade.minimumOutputDisplay = input.side === 'buy'
      ? scaledAtomicToDecimal(best.minimumOut, asset.token.decimals, asset.multiplier.value)
      : atomicToDecimal(best.minimumOut, usdc.decimals);
    return { asset, trade, quoteResponse };
  }

  async referencePrices(symbolInputs: string[]): Promise<{ prices: Record<string, { value: string; source: 'xstocks' | 'jupiter'; fetchedAt: number }> }> {
    const catalog = await this.catalog();
    const official = new Map(catalog.assets.map((asset) => [asset.symbol.toUpperCase(), asset]));
    const symbols = [...new Set(symbolInputs.map(canonicalSymbol))].slice(0, MAX_REFERENCE_PRICE_SYMBOLS);
    const now = Date.now();
    const requested = symbols.flatMap((symbol) => {
      const asset = official.get(symbol);
      return asset ? [[symbol, asset] as const] : [];
    });
    const prices: Record<string, { value: string; source: 'xstocks' | 'jupiter'; fetchedAt: number }> = {};
    const missing: Array<readonly [string, StockAsset]> = [];
    for (const [symbol, asset] of requested) {
      const cached = this.prices.get(symbol);
      if (cached && cached.expiresAt > now) prices[symbol] = { value: cached.value, source: cached.source, fetchedAt: cached.fetchedAt };
      else missing.push([symbol, asset]);
    }
    if (!missing.length) return { prices };
    // Directory pricing must stay fast and rate-safe: one canonical-mint
    // Jupiter batch covers every visible row. The selected asset detail path
    // still checks and prefers its issuer reference independently.
    const jupiterPrices = await this.jupiterMarketPrices(missing.map(([, asset]) => asset));
    for (const [symbol] of missing) {
      const price = jupiterPrices.get(symbol) ?? null;
      if (!price) continue;
      const fetchedAt = Date.now();
      this.prices.set(symbol, { ...price, fetchedAt, expiresAt: fetchedAt + config.xstocksDetailCacheMs });
      prices[symbol] = { ...price, fetchedAt };
    }
    return { prices };
  }

  async diagnostics(): Promise<{ available: boolean; assetCount: number; status: 'ready' | 'degraded'; checkedAt: number; detail: string }> {
    try {
      if (this.catalogCache) {
        const live = this.catalogCache.expiresAt > Date.now();
        return {
          available: live && this.catalogCache.assets.length > 0,
          assetCount: this.catalogCache.assets.length,
          status: live ? 'ready' : 'degraded',
          checkedAt: Date.now(),
          detail: live
            ? this.catalogCache.directoryComplete
              ? String(this.catalogCache.assets.length) + ' official Solana xStocks deployments loaded.'
              : String(this.catalogCache.assets.length) + ' official Solana xStock is ready while the full directory refreshes.'
            : 'The xStocks catalog cache expired and will refresh on the Stocks page.',
        };
      }
      // Warm the complete catalog without delaying health. The SPA requests
      // health on startup, so the Stocks directory is usually ready before a
      // user navigates there; /stocks coalesces with this same bounded load.
      void this.loadCatalogCoalesced().catch(() => undefined);
      const url = new URL('/api/v2/public/assets/AAPLx', config.xstocksBaseUrl);
      const payload = await fetchXstocks(url, 500_000);
      const probe = assetSchema.safeParse(payload);
      const valid = probe.success && normalizeAsset(probe.data) !== null;
      return {
        available: valid,
        assetCount: valid ? 1 : 0,
        status: valid ? 'ready' : 'degraded',
        checkedAt: Date.now(),
        detail: valid ? 'The official xStocks Solana catalog probe passed.' : 'The official xStocks catalog probe was malformed.',
      };
    } catch (error) {
      return {
        available: false,
        assetCount: 0,
        status: 'degraded',
        checkedAt: Date.now(),
        detail: error instanceof Error ? error.message : 'xStocks is unavailable.',
      };
    }
  }

  private catalogResponse(cache: CatalogCache, status: 'live' | 'stale', warning: string | null): StockCatalogResponse {
    return { assets: cache.assets, status, directoryComplete: cache.directoryComplete, fetchedAt: cache.fetchedAt, provider: 'xStocks', warning };
  }

  private catalogWarning(cache: CatalogCache): string | null {
    return cache.directoryComplete
      ? null
      : 'Loading the full official xStocks directory. Only currently validated assets are available.';
  }

  private loadInitialCatalogCoalesced(): Promise<CatalogCache> {
    if (this.initialCatalogInflight) return this.initialCatalogInflight;
    this.initialCatalogInflight = this.loadInitialCatalog().finally(() => { this.initialCatalogInflight = null; });
    return this.initialCatalogInflight;
  }

  private async loadInitialCatalog(): Promise<CatalogCache> {
    const url = new URL('/api/v2/public/assets/AAPLx', config.xstocksBaseUrl);
    const payload = await fetchXstocks(url, 500_000, { timeoutMs: config.xstocksTimeoutMs, retry: false });
    const result = assetSchema.safeParse(payload);
    const asset = result.success ? normalizeAsset(result.data) : null;
    if (!asset || asset.symbol.toUpperCase() !== 'AAPLX') {
      throw new AppError(502, 'XSTOCKS_BAD_RESPONSE', 'xStocks returned an invalid initial Solana asset.', true);
    }
    const fetchedAt = Date.now();
    const cache = { assets: [asset], directoryComplete: false, fetchedAt, expiresAt: fetchedAt + config.xstocksCatalogCacheMs };
    this.catalogCache = cache;
    void this.loadCatalogCoalesced().catch(() => undefined);
    return cache;
  }

  private loadCatalogCoalesced(): Promise<CatalogCache> {
    if (this.catalogInflight) return this.catalogInflight;
    this.catalogInflight = this.loadCatalog().finally(() => { this.catalogInflight = null; });
    return this.catalogInflight;
  }

  private async loadCatalog(): Promise<CatalogCache> {
    const rows: z.infer<typeof assetSchema>[] = [];
    let nextPage = 0;
    let hasNext = true;
    while (hasNext && nextPage < MAX_CATALOG_PAGES) {
      const pages = Array.from({ length: Math.min(PAGE_BATCH_SIZE, MAX_CATALOG_PAGES - nextPage) }, (_, index) => nextPage + index);
      const responses = await Promise.all(pages.map((page) => this.fetchCatalogPage(page)));
      for (const response of responses) {
        if (response.page.currentPage !== nextPage) {
          throw new AppError(502, 'XSTOCKS_BAD_RESPONSE', 'xStocks returned catalog pages out of order.', true);
        }
        rows.push(...response.nodes);
        if (rows.length > MAX_CATALOG_ASSETS) throw new AppError(502, 'XSTOCKS_CATALOG_TOO_LARGE', 'xStocks returned too many assets.', true);
        hasNext = response.page.hasNextPage;
        nextPage += 1;
        if (!hasNext) break;
      }
    }
    if (hasNext) throw new AppError(502, 'XSTOCKS_PAGE_LIMIT', 'xStocks catalog exceeded the reviewed page limit.', true);

    const bySymbol = new Map<string, StockAsset>();
    for (const row of rows) {
      const asset = normalizeAsset(row);
      if (!asset) continue;
      const key = asset.symbol.toUpperCase();
      const existing = bySymbol.get(key);
      if (existing && existing.mint !== asset.mint) {
        throw new AppError(502, 'XSTOCKS_CONFLICTING_MINT', `xStocks returned conflicting Solana mints for ${asset.symbol}.`, true);
      }
      bySymbol.set(key, asset);
    }
    const assets = [...bySymbol.values()].sort((left, right) => left.underlyingSymbol.localeCompare(right.underlyingSymbol));
    if (!assets.length) throw new AppError(502, 'XSTOCKS_EMPTY_CATALOG', 'xStocks returned no valid Solana deployments.', true);
    const fetchedAt = Date.now();
    const cache = { assets, directoryComplete: true, fetchedAt, expiresAt: fetchedAt + config.xstocksCatalogCacheMs };
    this.catalogCache = cache;
    return cache;
  }

  private async fetchCatalogPage(page: number) {
    const url = new URL('/api/v2/public/assets', config.xstocksBaseUrl);
    url.searchParams.set('network', 'Solana');
    url.searchParams.set('page', String(page));
    url.searchParams.set('pageSize', String(CATALOG_PAGE_SIZE));
    const payload = await fetchXstocks(url, 4_000_000, { timeoutMs: config.xstocksCatalogTimeoutMs, retry: false });
    const result = catalogPageSchema.safeParse(payload);
    if (!result.success) throw new AppError(502, 'XSTOCKS_BAD_RESPONSE', 'xStocks returned an invalid catalog page.', true);
    return result.data;
  }

  private async loadDetail(official: StockAsset): Promise<StockAsset> {
    const encoded = encodeURIComponent(official.symbol);
    const assetUrl = new URL(`/api/v2/public/assets/${encoded}`, config.xstocksBaseUrl);
    const priceUrl = new URL(`/api/v2/public/assets/${encoded}/price-data`, config.xstocksBaseUrl);
    const multiplierUrl = new URL(`/api/v2/public/assets/${encoded}/multiplier`, config.xstocksBaseUrl);
    multiplierUrl.searchParams.set('network', 'Solana');
    const tokenPromise = this.verifiedStockToken(official);
    const [assetPayload, multiplierPayload, issuerReference, token, jupiterPrices] = await Promise.all([
      fetchXstocks(assetUrl, 500_000, { timeoutMs: config.xstocksDetailTimeoutMs, retry: false }),
      fetchXstocks(multiplierUrl, 20_000, { timeoutMs: config.xstocksDetailTimeoutMs, retry: false }),
      this.issuerReferencePrice(priceUrl),
      tokenPromise,
      this.jupiterMarketPrices([official]),
    ]);
    const assetResult = assetSchema.safeParse(assetPayload);
    const multiplierResult = multiplierSchema.safeParse(multiplierPayload);
    if (!assetResult.success || !multiplierResult.success) {
      throw new AppError(502, 'XSTOCKS_BAD_RESPONSE', 'xStocks returned invalid asset detail.', true);
    }
    const confirmed = normalizeAsset(assetResult.data);
    if (!confirmed || confirmed.symbol.toUpperCase() !== official.symbol.toUpperCase() || confirmed.mint !== official.mint) {
      throw new AppError(502, 'XSTOCKS_MINT_MISMATCH', 'xStocks detail did not match its canonical catalog mint.', true);
    }
    const fetchedAt = Date.now();
    const reference = issuerReference ?? jupiterPrices.get(official.symbol.toUpperCase()) ?? null;
    const referencePrice = reference?.value ?? null;
    const multiplierValue = normalizeMultiplier(multiplierResult.data.currentMultiplier);
    const verifiedToken = token && reference ? { ...token, usdPrice: Number(reference.value) } : token;
    const asset: StockAsset = {
      ...confirmed,
      referencePrice,
      referencePriceSource: reference?.source ?? null,
      referencePriceFetchedAt: referencePrice ? fetchedAt : null,
      multiplier: {
        value: multiplierValue,
        fetchedAt,
        nextValue: multiplierResult.data.newMultiplier > 0 ? normalizeMultiplier(multiplierResult.data.newMultiplier) : null,
        nextActivationAt: multiplierResult.data.activationDateTime > 0 ? multiplierResult.data.activationDateTime : null,
        reason: multiplierResult.data.reason,
      },
      token: verifiedToken,
    };
    if (reference) this.prices.set(official.symbol.toUpperCase(), { ...reference, fetchedAt, expiresAt: fetchedAt + config.xstocksDetailCacheMs });
    // An asset without a completed on-chain check is safe to display, but not
    // to cache as executable: the next refresh must re-attempt verification.
    if (verifiedToken) this.details.set(official.symbol.toUpperCase(), { asset, expiresAt: fetchedAt + config.xstocksDetailCacheMs });
    return asset;
  }

  private async issuerReferencePrice(url: URL): Promise<ReferencePrice | null> {
    try {
      const payload = await fetchXstocks(url, 20_000, { timeoutMs: config.xstocksReferenceTimeoutMs, retry: false });
      const result = priceSchema.safeParse(payload);
      return result.success ? { value: result.data.quote.toString(), source: 'xstocks' } : null;
    } catch {
      return null;
    }
  }

  private async jupiterMarketPrices(assets: StockAsset[]): Promise<Map<string, ReferencePrice>> {
    const canonical = [...new Map(assets.slice(0, MAX_REFERENCE_PRICE_SYMBOLS).map((asset) => [asset.mint, asset])).values()];
    if (!canonical.length) return new Map();
    const url = new URL('/price/v3', config.jupiterBaseUrl);
    url.searchParams.set('ids', canonical.map((asset) => asset.mint).join(','));
    try {
      const payload = await fetchJson<Record<string, unknown>>(url, {
        provider: 'Jupiter Price V3',
        timeoutMs: config.xstocksReferenceTimeoutMs,
        maxBytes: 250_000,
        headers: providerHeaders(),
      });
      const results = new Map<string, ReferencePrice>();
      for (const asset of canonical) {
        const row = payload[asset.mint];
        if (!row || typeof row !== 'object') continue;
        const record = row as Record<string, unknown>;
        const stockData = record.stockData && typeof record.stockData === 'object' ? record.stockData as Record<string, unknown> : null;
        const scaledUiConfig = record.scaledUiConfig && typeof record.scaledUiConfig === 'object' ? record.scaledUiConfig as Record<string, unknown> : null;
        const value = [stockData?.price, scaledUiConfig?.usdPricePrescaled, record.usdPrice]
          .find((candidate): candidate is number => typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0 && candidate <= 1_000_000_000);
        if (value !== undefined) results.set(asset.symbol.toUpperCase(), { value: value.toString(), source: 'jupiter' });
      }
      return results;
    } catch {
      return new Map();
    }
  }

  private async verifiedStockToken(official: StockAsset): Promise<StockAsset['token']> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        this.tokens.getOfficialStockByMint(official.mint, {
          symbol: official.symbol,
          name: official.name,
          logoUri: official.logoUri,
          usdPrice: null,
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new AppError(504, 'XSTOCKS_ONCHAIN_TIMEOUT', 'Solana on-chain stock verification did not respond in time.', true)), config.xstocksOnchainTimeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof AppError && (error.code === 'RPC_UNAVAILABLE' || error.code === 'XSTOCKS_ONCHAIN_TIMEOUT')) return null;
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
