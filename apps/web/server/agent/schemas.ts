import { PublicKey } from '@solana/web3.js';
import ipaddr from 'ipaddr.js';
import { z } from 'zod';
import { MAX_SLIPPAGE_BPS, MIN_SLIPPAGE_BPS } from '../../shared/constants.js';

const MAX_X402_BODY_BYTES = 8 * 1024;

function parseX402Url(value: string): URL | null {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.port
      || ipaddr.isValid(hostname) || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return null;
    return parsed;
  } catch {
    return null;
  }
}

export const agentX402OriginSchema = z.string().trim().min(1).max(255)
  .refine((value) => {
    const parsed = parseX402Url(value);
    return Boolean(parsed && parsed.pathname === '/' && !parsed.search);
  }, 'Use an HTTPS origin only, for example https://api.example.com.')
  .transform((value) => new URL(value).origin);

export const agentX402UrlSchema = z.string().trim().min(1).max(2_048)
  .refine((value) => Boolean(parseX402Url(value)), 'Use a complete HTTPS URL without credentials, fragments, or a custom port.')
  .transform((value) => new URL(value).toString());

export const agentPublicKeySchema = z.string().min(32).max(44).refine((value) => {
  try { return new PublicKey(value).toBase58() === value; } catch { return false; }
}, 'Invalid Solana address.');

export const agentAtomicAmountSchema = z.string().regex(/^[1-9]\d*$/).refine(
  (value) => !/^[1-9]\d*$/.test(value) || BigInt(value) <= 18_446_744_073_709_551_615n,
  'Amount exceeds the Solana u64 limit.',
);

export const agentStockSymbolSchema = z.string().trim().toUpperCase().min(2).max(24).regex(/^[A-Z0-9.]+$/);
export const agentFuturesMarketSchema = z.enum(['SOL-PERP', 'BTC-PERP', 'ETH-PERP']);
export const agentStockAmountSchema = z.string().trim().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/).refine((value) => Number(value) > 0);

export const agentPolicySchema = z.object({
  wallet: agentPublicKeySchema,
  name: z.string().trim().min(2).max(60),
  approvalMode: z.enum(['always-ask', 'automatic']).default('always-ask'),
  products: z.array(z.enum(['convert', 'stocks', 'futures', 'x402'])).min(1).max(4).transform((items) => [...new Set(items)]),
  maxTransactionUsd: z.number().finite().min(1).max(1_000_000),
  maxDailyUsd: z.number().finite().min(1).max(10_000_000),
  maxSlippageBps: z.number().int().min(MIN_SLIPPAGE_BPS).max(MAX_SLIPPAGE_BPS),
  maxFuturesLeverage: z.number().int().min(1).max(10),
  maxOpenFuturesPositions: z.number().int().min(1).max(20),
  allowedTokenMints: z.array(agentPublicKeySchema).max(100).transform((items) => [...new Set(items)]),
  allowedStockSymbols: z.array(agentStockSymbolSchema).max(100).transform((items) => [...new Set(items)]),
  allowedFuturesMarkets: z.array(agentFuturesMarketSchema).max(3).transform((items) => [...new Set(items)]),
  x402AllowedOrigins: z.array(agentX402OriginSchema).max(20).default([]).transform((items) => [...new Set(items)]),
  x402AllowedMethods: z.array(z.enum(['GET', 'POST'])).min(1).max(2).default(['GET']).transform((items) => [...new Set(items)]),
  maxX402PaymentAtomic: agentAtomicAmountSchema.default('10000'),
  maxX402DailyAtomic: agentAtomicAmountSchema.default('1000000'),
  expiresInHours: z.number().int().min(1).max(24 * 30),
}).strict().superRefine((value, context) => {
  if (value.maxDailyUsd < value.maxTransactionUsd) {
    context.addIssue({ code: 'custom', path: ['maxDailyUsd'], message: 'Daily limit must be at least the per-request limit.' });
  }
  if (value.products.includes('convert') && value.allowedTokenMints.length < 2) {
    context.addIssue({ code: 'custom', path: ['allowedTokenMints'], message: 'Convert access requires at least two allowed token mints.' });
  }
  if (value.products.includes('stocks') && value.allowedStockSymbols.length < 1) {
    context.addIssue({ code: 'custom', path: ['allowedStockSymbols'], message: 'Stocks access requires at least one allowed symbol.' });
  }
  if (value.products.includes('futures') && value.allowedFuturesMarkets.length < 1) {
    context.addIssue({ code: 'custom', path: ['allowedFuturesMarkets'], message: 'Futures access requires at least one allowed market.' });
  }
  if (value.products.includes('x402') && value.x402AllowedOrigins.length < 1) {
    context.addIssue({ code: 'custom', path: ['x402AllowedOrigins'], message: 'x402 access requires at least one allowed HTTPS origin.' });
  }
  if (BigInt(value.maxX402DailyAtomic) < BigInt(value.maxX402PaymentAtomic)) {
    context.addIssue({ code: 'custom', path: ['maxX402DailyAtomic'], message: 'The x402 daily limit must be at least the per-payment limit.' });
  }
});

const convertIntent = z.object({
  kind: z.literal('convert'),
  inputMint: agentPublicKeySchema,
  outputMint: agentPublicKeySchema,
  amountAtomic: agentAtomicAmountSchema,
  slippageBps: z.number().int().min(MIN_SLIPPAGE_BPS).max(MAX_SLIPPAGE_BPS),
}).strict().refine((value) => value.inputMint !== value.outputMint, { path: ['outputMint'], message: 'Choose different tokens.' });

const stockIntent = z.object({
  kind: z.literal('stock'),
  symbol: agentStockSymbolSchema,
  side: z.enum(['buy', 'sell']),
  amount: agentStockAmountSchema,
  slippageBps: z.number().int().min(MIN_SLIPPAGE_BPS).max(MAX_SLIPPAGE_BPS),
}).strict();

const futuresOpenIntent = z.object({
  kind: z.literal('futures-open'),
  market: agentFuturesMarketSchema,
  side: z.enum(['long', 'short']),
  orderType: z.enum(['market', 'limit']),
  collateralAtomic: agentAtomicAmountSchema.refine((value) => BigInt(value) >= 1_000_000n, 'Minimum collateral is 1 USDC.'),
  leverageBps: z.number().int().min(10_000).max(100_000),
  limitPriceMicroUsd: agentAtomicAmountSchema.optional(),
  slippageBps: z.number().int().min(1).max(500),
  routeChoice: z.enum(['auto', 'phoenix', 'gmtrade']),
}).strict().superRefine((value, context) => {
  if (value.orderType === 'limit' && !value.limitPriceMicroUsd) context.addIssue({ code: 'custom', path: ['limitPriceMicroUsd'], message: 'Limit price is required.' });
  if (value.orderType === 'market' && value.limitPriceMicroUsd) context.addIssue({ code: 'custom', path: ['limitPriceMicroUsd'], message: 'Market orders cannot include a limit price.' });
});

const futuresManageIntent = z.object({
  kind: z.literal('futures-manage'),
  action: z.enum(['close', 'cancel']),
  venue: z.enum(['phoenix', 'gmtrade']),
  market: agentFuturesMarketSchema,
  nativeId: z.string().min(1).max(128),
}).strict();

const x402Intent = z.object({
  kind: z.literal('x402'),
  url: agentX402UrlSchema,
  method: z.enum(['GET', 'POST']).default('GET'),
  body: z.record(z.string().min(1).max(128), z.unknown()).optional(),
  maxPaymentAtomic: agentAtomicAmountSchema,
}).strict().superRefine((value, context) => {
  if (value.method === 'GET' && value.body !== undefined) {
    context.addIssue({ code: 'custom', path: ['body'], message: 'GET x402 requests cannot include a body.' });
  }
  if (value.body !== undefined) {
    let serialized = '';
    try { serialized = JSON.stringify(value.body); } catch { /* Report the bounded JSON error below. */ }
    if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_X402_BODY_BYTES) {
      context.addIssue({ code: 'custom', path: ['body'], message: 'The x402 JSON body must be at most 8 KiB.' });
    }
  }
});

export const agentIntentSubmissionSchema = z.object({
  idempotencyKey: z.string().uuid(),
  intent: z.discriminatedUnion('kind', [convertIntent, stockIntent, futuresOpenIntent, futuresManageIntent, x402Intent]),
}).strict();

export const agentRequestActionSchema = z.object({ wallet: agentPublicKeySchema }).strict();

export const agentExecuteSchema = z.object({
  wallet: agentPublicKeySchema,
  signedTransaction: z.string().min(100).max(20_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  idempotencyKey: z.string().uuid(),
}).strict();

export const agentSponsoredCompleteSchema = z.object({
  wallet: agentPublicKeySchema,
  signature: z.string().min(80).max(90).regex(/^[1-9A-HJ-NP-Za-km-z]+$/),
}).strict();

export const agentWorkspaceSchema = z.object({ wallet: agentPublicKeySchema }).strict();
