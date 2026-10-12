import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getExtensionTypes,
  unpackMint,
} from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { atomicToDecimal } from '../shared/amounts.js';
import { JUP_MINT, SOL_MINT, USDC_MINT } from '../shared/constants.js';
import type { TokenInfo, WalletBalances } from '../shared/types.js';
import { config, providerHeaders } from './config.js';
import { AppError } from './errors.js';
import { fetchJson } from './fetch-json.js';
import { withRpcFallback } from './rpc.js';

interface JupiterToken {
  id: string;
  name?: string;
  symbol?: string;
  icon?: string;
  decimals?: number;
  tokenProgram?: string;
  usdPrice?: number;
  isVerified?: boolean;
  tags?: string[];
}

interface JupiterPrice {
  usdPrice?: number;
}

const CORE_METADATA = new Map<string, JupiterToken>([
  [SOL_MINT, {
    id: SOL_MINT,
    name: 'Solana',
    symbol: 'SOL',
    icon: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
    decimals: 9,
    tokenProgram: 'native',
    isVerified: true,
    tags: ['strict', 'verified', 'major'],
  }],
  [USDC_MINT, {
    id: USDC_MINT,
    name: 'USD Coin',
    symbol: 'USDC',
    icon: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png',
    decimals: 6,
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    usdPrice: 1,
    isVerified: true,
    tags: ['strict', 'verified', 'stable'],
  }],
  [JUP_MINT, {
    id: JUP_MINT,
    name: 'Jupiter',
    symbol: 'JUP',
    decimals: 6,
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    isVerified: true,
    tags: ['strict', 'verified'],
  }],
]);

function coreToken(mint: string): TokenInfo | null {
  const metadata = CORE_METADATA.get(mint);
  if (!metadata) return null;
  return normalizeMetadata(metadata, mint === SOL_MINT ? 'native' : 'spl-token', []);
}

const BLOCKED_EXTENSIONS = new Set([
  'TransferFeeConfig',
  'ConfidentialTransferMint',
  'ConfidentialTransferFeeConfig',
  'DefaultAccountState',
  'NonTransferable',
  'InterestBearingConfig',
  'PermanentDelegate',
  'TransferHook',
  'ScaledUiAmountConfig',
  'PausableConfig',
]);

// Official xStocks intentionally combine these Token-2022 controls. They stay
// blocked in Convert and are enabled only after StockService binds a canonical
// issuer mint; the resulting Jupiter transaction is still structurally checked
// and simulated before it can reach wallet approval.
const OFFICIAL_XSTOCKS_EXTENSIONS = new Set([
  'ScaledUiAmountConfig',
  'PermanentDelegate',
  'DefaultAccountState',
  'PausableConfig',
  'ConfidentialTransferMint',
  'TransferHook',
]);

function stockReason(tags: string[]): string | null {
  return tags.some((tag) => /xstocks?|tokenized[-_ ]?stock|equity/i.test(tag))
    ? 'Tokenized stocks are planned for a later Flay release and are disabled in Convert.'
    : null;
}

function normalizeMetadata(item: JupiterToken, tokenProgram: TokenInfo['tokenProgram'], extensions: string[]): TokenInfo {
  const tags = Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string') : [];
  const unsupported = extensions.filter((extension) => BLOCKED_EXTENSIONS.has(extension));
  const reason = stockReason(tags)
    ?? (unsupported.length
      ? `This Token-2022 mint uses unsupported extensions: ${unsupported.join(', ')}.`
      : null);
  return {
    mint: item.id,
    symbol: (item.symbol || `${item.id.slice(0, 4)}…${item.id.slice(-4)}`).slice(0, 20),
    name: (item.name || 'Unlisted Solana token').slice(0, 80),
    decimals: Number.isInteger(item.decimals) ? Number(item.decimals) : 0,
    logoUri: typeof item.icon === 'string' && /^https:\/\//.test(item.icon) ? item.icon : null,
    tokenProgram,
    verified: item.isVerified === true,
    tags,
    extensions,
    tradable: !reason,
    blockedReason: reason,
    usdPrice: typeof item.usdPrice === 'number' && Number.isFinite(item.usdPrice) ? item.usdPrice : null,
  };
}

interface MetadataBatch {
  mints: Set<string>;
  requests: Array<{ mints: string[]; resolve: (metadata: Map<string, JupiterToken>) => void }>;
}

interface PriceBatch {
  mints: Set<string>;
  requests: Array<{ mints: string[]; resolve: (prices: Map<string, number>) => void }>;
}

export class TokenService {
  private readonly cache = new Map<string, { expiresAt: number; token: TokenInfo }>();
  private metadataBatch: MetadataBatch | null = null;
  private priceBatch: PriceBatch | null = null;

  async search(query: string): Promise<TokenInfo[]> {
    const trimmed = query.trim();
    try {
      const mint = new PublicKey(trimmed).toBase58();
      return [await this.getByMint(mint)];
    } catch {
      // Symbol and name searches use Jupiter's indexed metadata, then on-chain validation occurs on selection.
    }

    const url = new URL('/tokens/v2/search', config.jupiterBaseUrl);
    url.searchParams.set('query', trimmed);
    const rows = await fetchJson<JupiterToken[]>(url, {
      provider: 'Jupiter Tokens',
      headers: providerHeaders(),
      timeoutMs: config.requestTimeoutMs,
    });
    if (!Array.isArray(rows)) throw new AppError(502, 'TOKEN_INDEX_BAD_RESPONSE', 'Jupiter Tokens returned an invalid token list.', true);
    return rows.slice(0, 20).map((item) => {
      const program = item.id === SOL_MINT
        ? 'native'
        : item.tokenProgram === TOKEN_2022_PROGRAM_ID.toBase58() ? 'token-2022' : 'spl-token';
      return normalizeMetadata(item, program, []);
    });
  }

  async getByMint(mint: string): Promise<TokenInfo> {
    const cached = this.cache.get(mint);
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    const core = coreToken(mint);
    if (core) {
      if (core.usdPrice !== null) return core;
      const price = (await this.fetchPrices([mint])).get(mint) ?? null;
      const token = price === null ? core : { ...core, usdPrice: price };
      this.cache.set(mint, { expiresAt: Date.now() + 30_000, token });
      return token;
    }

    let address: PublicKey;
    try {
      address = new PublicKey(mint);
    } catch {
      throw new AppError(400, 'WRONG_MINT', 'The token mint is not a valid Solana address.');
    }

    const [accountInfo, metadataRows] = await Promise.all([
      withRpcFallback((rpc) => rpc.getAccountInfo(address, 'confirmed')),
      this.fetchMetadata([mint]),
    ]);
    if (!accountInfo) throw new AppError(404, 'WRONG_MINT', 'No mint account exists at that Solana address.');

    const isLegacy = accountInfo.owner.equals(TOKEN_PROGRAM_ID);
    const isToken2022 = accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID);
    if (!isLegacy && !isToken2022) {
      throw new AppError(400, 'WRONG_MINT', 'That address is not owned by a supported Solana token program.');
    }

    let mintState;
    try {
      mintState = unpackMint(address, accountInfo, accountInfo.owner);
    } catch {
      throw new AppError(400, 'WRONG_MINT', 'That address is not a valid token mint.');
    }

    const extensions = isToken2022
      ? getExtensionTypes(mintState.tlvData).map((extension) => ExtensionType[extension] ?? `Extension ${extension}`)
      : [];
    const metadata = metadataRows.get(mint) ?? { id: mint };
    metadata.decimals = mintState.decimals;
    metadata.tokenProgram = accountInfo.owner.toBase58();
    const token = normalizeMetadata(metadata, mint === SOL_MINT ? 'native' : isToken2022 ? 'token-2022' : 'spl-token', extensions);
    if (this.cache.size >= 1_000) {
      const now = Date.now();
      for (const [key, value] of this.cache) if (value.expiresAt <= now) this.cache.delete(key);
      if (this.cache.size >= 1_000) {
        const oldest = this.cache.keys().next().value as string | undefined;
        if (oldest) this.cache.delete(oldest);
      }
    }
    this.cache.set(mint, { expiresAt: Date.now() + 5 * 60_000, token });
    return token;
  }

  async getOfficialStockByMint(
    mint: string,
    official: { symbol: string; name: string; logoUri: string | null; usdPrice: number | null },
  ): Promise<TokenInfo> {
    const token = await this.getByMint(mint);
    const blockedBeyondOfficialPolicy = token.extensions.filter(
      (extension) => BLOCKED_EXTENSIONS.has(extension) && !OFFICIAL_XSTOCKS_EXTENSIONS.has(extension),
    );
    if (token.tokenProgram !== 'token-2022' || !token.extensions.includes('ScaledUiAmountConfig')) {
      throw new AppError(409, 'XSTOCKS_MINT_UNSUPPORTED', 'The official xStocks mint is not an expected Token-2022 Scaled UI Amount mint.');
    }
    if (blockedBeyondOfficialPolicy.length) {
      throw new AppError(409, 'XSTOCKS_MINT_UNSUPPORTED', `The official xStocks mint uses unsupported extensions: ${blockedBeyondOfficialPolicy.join(', ')}.`);
    }
    return {
      ...token,
      symbol: official.symbol.slice(0, 20),
      name: official.name.slice(0, 80),
      logoUri: official.logoUri,
      verified: true,
      tags: [...new Set([...token.tags, 'xstocks', 'tokenized-stock'])],
      tradable: true,
      blockedReason: null,
      usdPrice: official.usdPrice,
    };
  }

  async getManyMetadata(mints: string[]): Promise<Map<string, JupiterToken>> {
    return this.fetchMetadata(mints);
  }

  async balances(wallet: string): Promise<WalletBalances> {
    const owner = new PublicKey(wallet);
    const [sol, legacy, token2022] = await Promise.all([
      withRpcFallback((rpc) => rpc.getBalanceAndContext(owner, 'confirmed')),
      withRpcFallback((rpc) => rpc.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }, 'confirmed')),
      withRpcFallback((rpc) => rpc.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }, 'confirmed')),
    ]);

    const aggregates = new Map<string, { amount: bigint; decimals: number; program: TokenInfo['tokenProgram'] }>();
    for (const response of [legacy, token2022]) {
      for (const row of response.value) {
        const parsed = row.account.data;
        if (!('parsed' in parsed)) continue;
        const info = parsed.parsed.info as { mint?: string; tokenAmount?: { amount?: string; decimals?: number } };
        if (!info.mint || !info.tokenAmount?.amount || !Number.isInteger(info.tokenAmount.decimals)) continue;
        const existing = aggregates.get(info.mint);
        const program = row.account.owner.equals(TOKEN_2022_PROGRAM_ID) ? 'token-2022' : 'spl-token';
        aggregates.set(info.mint, {
          amount: (existing?.amount ?? 0n) + BigInt(info.tokenAmount.amount),
          decimals: Number(info.tokenAmount.decimals),
          program,
        });
      }
    }
    aggregates.set(SOL_MINT, { amount: BigInt(sol.value), decimals: 9, program: 'native' });

    const nonzero = [...aggregates.entries()].filter(([, value]) => value.amount > 0n);
    const metadata = await this.fetchMetadata(nonzero.flatMap(([mint]) => CORE_METADATA.has(mint) ? [] : [mint]));
    const balances = nonzero.map(([mint, value]) => {
      const row = CORE_METADATA.get(mint) ?? metadata.get(mint) ?? { id: mint, decimals: value.decimals };
      row.decimals = value.decimals;
      const token = normalizeMetadata(row, value.program, []);
      return {
        token,
        amountAtomic: value.amount.toString(),
        uiAmount: atomicToDecimal(value.amount, value.decimals),
      };
    }).sort((a, b) => {
      if (a.token.mint === SOL_MINT) return -1;
      if (b.token.mint === SOL_MINT) return 1;
      const aUsd = Number(a.uiAmount) * (a.token.usdPrice ?? 0);
      const bUsd = Number(b.uiAmount) * (b.token.usdPrice ?? 0);
      return bUsd - aUsd;
    });

    return {
      wallet,
      slot: Math.max(sol.context.slot, legacy.context.slot, token2022.context.slot),
      fetchedAt: Date.now(),
      balances,
    };
  }

  private fetchMetadata(mints: string[]): Promise<Map<string, JupiterToken>> {
    const unique = [...new Set(mints)].slice(0, 100);
    if (!unique.length) return Promise.resolve(new Map());

    return new Promise((resolve) => {
      if (!this.metadataBatch) {
        const batch: MetadataBatch = { mints: new Set(), requests: [] };
        this.metadataBatch = batch;
        setTimeout(() => void this.flushMetadata(batch), 10);
      }
      unique.forEach((mint) => this.metadataBatch!.mints.add(mint));
      this.metadataBatch.requests.push({ mints: unique, resolve });
    });
  }

  private fetchPrices(mints: string[]): Promise<Map<string, number>> {
    const unique = [...new Set(mints)].slice(0, 100);
    if (!unique.length) return Promise.resolve(new Map());
    return new Promise((resolve) => {
      if (!this.priceBatch) {
        const batch: PriceBatch = { mints: new Set(), requests: [] };
        this.priceBatch = batch;
        setTimeout(() => void this.flushPrices(batch), 10);
      }
      unique.forEach((mint) => this.priceBatch!.mints.add(mint));
      this.priceBatch.requests.push({ mints: unique, resolve });
    });
  }

  private async flushPrices(batch: PriceBatch): Promise<void> {
    if (this.priceBatch === batch) this.priceBatch = null;
    const requested = [...batch.mints].slice(0, 100);
    const url = new URL('/price/v3', config.jupiterBaseUrl);
    url.searchParams.set('ids', requested.join(','));
    let prices = new Map<string, number>();
    try {
      const payload = await fetchJson<Record<string, JupiterPrice>>(url, {
        provider: 'Jupiter Price',
        headers: providerHeaders(),
        timeoutMs: config.requestTimeoutMs,
        maxBytes: 500_000,
      });
      prices = new Map(Object.entries(payload).flatMap(([mint, row]) => (
        typeof row?.usdPrice === 'number' && Number.isFinite(row.usdPrice) && row.usdPrice > 0
          ? [[mint, row.usdPrice] as const]
          : []
      )));
    } catch {
      // Agent risk checks fail closed when the live canonical price is unavailable.
    }
    batch.requests.forEach((request) => {
      request.resolve(new Map(request.mints.flatMap((mint) => {
        const value = prices.get(mint);
        return value === undefined ? [] : [[mint, value] as const];
      })));
    });
  }

  private async flushMetadata(batch: MetadataBatch): Promise<void> {
    if (this.metadataBatch === batch) this.metadataBatch = null;
    const requested = [...batch.mints].slice(0, 100);
    const url = new URL('/tokens/v2/search', config.jupiterBaseUrl);
    url.searchParams.set('query', requested.join(','));
    let metadata = new Map<string, JupiterToken>();
    try {
      const rows = await fetchJson<JupiterToken[]>(url, {
        provider: 'Jupiter Tokens',
        headers: providerHeaders(),
        timeoutMs: config.requestTimeoutMs,
      });
      metadata = new Map((Array.isArray(rows) ? rows : []).map((row) => [row.id, row]));
    } catch {
      // Metadata is optional. On-chain mint validation and safe fallback labels still apply.
    }
    batch.requests.forEach((request) => {
      request.resolve(new Map(request.mints.flatMap((mint) => {
        const value = metadata.get(mint);
        return value ? [[mint, value] as const] : [];
      })));
    });
  }
}
