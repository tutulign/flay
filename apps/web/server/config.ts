import 'dotenv/config';

function clean(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

const rpcUrl = clean(process.env.SOLANA_RPC_URL) ?? 'https://api.mainnet-beta.solana.com';
const rpcWsUrl = clean(process.env.SOLANA_RPC_WS_URL);
const fallbackRpcUrl = clean(process.env.SOLANA_FALLBACK_RPC_URL);
const alchemyPayEnvironment = process.env.ALCHEMY_PAY_ENV === 'production' ? 'production' : 'test';
const privyFiatOnrampEnvironment = process.env.VITE_PRIVY_ONRAMP_ENV === 'production' ? 'production' : 'sandbox';

function positiveDecimal(value: string | undefined, fallback: string): string {
  const candidate = clean(value) ?? fallback;
  return /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(candidate) && Number(candidate) > 0 ? candidate : fallback;
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const candidate = Number(clean(value));
  return Number.isInteger(candidate) && candidate >= minimum && candidate <= maximum ? candidate : fallback;
}

const alchemyPayAllowedFiat = [...new Set((clean(process.env.ALCHEMY_PAY_ALLOWED_FIAT) ?? 'USD,EUR,GBP')
  .split(',')
  .map((value) => value.trim().toUpperCase())
  .filter((value) => /^[A-Z]{3}$/.test(value)))];

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? '5173'),
  host: clean(process.env.HOST) ?? '0.0.0.0',
  rpcUrl,
  rpcWsUrl,
  fallbackRpcUrl: fallbackRpcUrl === rpcUrl ? undefined : fallbackRpcUrl,
  rpcMaxRequestsPerSecond: boundedInteger(process.env.SOLANA_RPC_MAX_RPS, 8, 1, 100),
  rpcMaxConcurrency: boundedInteger(process.env.SOLANA_RPC_MAX_CONCURRENCY, 4, 1, 32),
  rpcQueueTimeoutMs: boundedInteger(process.env.SOLANA_RPC_QUEUE_TIMEOUT_MS, 10_000, 250, 60_000),
  commitment: 'confirmed' as const,
  privyAppId: clean(process.env.PRIVY_APP_ID) ?? clean(process.env.VITE_PRIVY_APP_ID),
  privyVerificationKey: clean(process.env.PRIVY_VERIFICATION_KEY)?.replace(/\\n/g, '\n'),
  privyAppSecret: clean(process.env.PRIVY_APP_SECRET),
  privyAuthorizationPrivateKey: clean(process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY),
  privyAgentTimeoutMs: boundedInteger(process.env.PRIVY_AGENT_TIMEOUT_MS, 15_000, 1_000, 60_000),
  privyFiatOnrampEnvironment: privyFiatOnrampEnvironment as 'sandbox' | 'production',
  jupiterApiKey: clean(process.env.JUPITER_API_KEY),
  jupiterBaseUrl: clean(process.env.JUPITER_BASE_URL) ?? 'https://api.jup.ag',
  raydiumSwapUrl: clean(process.env.RAYDIUM_SWAP_URL) ?? 'https://transaction-v1.raydium.io',
  raydiumApiUrl: clean(process.env.RAYDIUM_API_URL) ?? 'https://api-v3.raydium.io',
  orcaApiUrl: clean(process.env.ORCA_API_URL) ?? 'https://api.orca.so',
  magicBlockBaseUrl: clean(process.env.MAGICBLOCK_BASE_URL) ?? 'https://payments.magicblock.app',
  magicBlockTeeBaseUrl: clean(process.env.MAGICBLOCK_TEE_BASE_URL) ?? 'https://mainnet-tee.magicblock.app',
  magicBlockTimeoutMs: Number(process.env.MAGICBLOCK_TIMEOUT_MS ?? '10000'),
  requestTimeoutMs: Number(process.env.PROVIDER_TIMEOUT_MS ?? '4500'),
  quoteCacheMs: Number(process.env.QUOTE_CACHE_MS ?? '5000'),
  xstocksBaseUrl: clean(process.env.XSTOCKS_BASE_URL) ?? 'https://api.xstocks.fi/api/v2',
  xstocksTimeoutMs: Number(process.env.XSTOCKS_TIMEOUT_MS ?? '10000'),
  xstocksDetailTimeoutMs: Number(process.env.XSTOCKS_DETAIL_TIMEOUT_MS ?? '6000'),
  xstocksReferenceTimeoutMs: Number(process.env.XSTOCKS_REFERENCE_TIMEOUT_MS ?? '3500'),
  xstocksOnchainTimeoutMs: Number(process.env.XSTOCKS_ONCHAIN_TIMEOUT_MS ?? '3500'),
  xstocksCatalogTimeoutMs: Number(process.env.XSTOCKS_CATALOG_TIMEOUT_MS ?? '45000'),
  xstocksCatalogCacheMs: Number(process.env.XSTOCKS_CATALOG_CACHE_MS ?? '600000'),
  xstocksDetailCacheMs: Number(process.env.XSTOCKS_DETAIL_CACHE_MS ?? '30000'),
  alchemyPay: {
    environment: alchemyPayEnvironment as 'test' | 'production',
    appId: clean(process.env.ALCHEMY_PAY_APP_ID),
    appSecret: clean(process.env.ALCHEMY_PAY_APP_SECRET),
    publicUrl: clean(process.env.ALCHEMY_PAY_PUBLIC_URL)?.replace(/\/$/, ''),
    orderStorePath: clean(process.env.ALCHEMY_PAY_ORDER_STORE_PATH),
    allowedFiat: alchemyPayAllowedFiat.length ? alchemyPayAllowedFiat : ['USD'],
    minFiatAmount: positiveDecimal(process.env.ALCHEMY_PAY_MIN_FIAT_AMOUNT, '15'),
    maxFiatAmount: positiveDecimal(process.env.ALCHEMY_PAY_MAX_FIAT_AMOUNT, '1000'),
  },
};

export function providerHeaders(includeJson = false): HeadersInit {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': 'Flay-Convert/0.1',
  };
  if (includeJson) headers['content-type'] = 'application/json';
  if (config.jupiterApiKey) headers['x-api-key'] = config.jupiterApiKey;
  return headers;
}

export function serverReadiness() {
  return {
    privy: Boolean(config.privyAppId && config.privyVerificationKey),
    privyAgentDelegation: Boolean(config.privyAppId && config.privyAppSecret && config.privyAuthorizationPrivateKey),
    jupiterSwap: true,
    // Trigger V1 currently accepts keyless requests; an API key only raises capacity.
    jupiterTrigger: true,
    rpc: Boolean(config.rpcUrl),
    raydium: true,
    orca: true,
    xstocks: true,
    magicBlock: Boolean(clean(process.env.MAGICBLOCK_BASE_URL) ?? 'https://payments.magicblock.app'),
    alchemyPay: Boolean(config.alchemyPay.appId && config.alchemyPay.appSecret && config.alchemyPay.publicUrl),
  };
}

export function rpcProviderLabel(): string {
  try {
    return new URL(config.rpcUrl).hostname;
  } catch {
    return 'configured Solana RPC';
  }
}
