import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import type { AgentIntentSubmission, AgentRequest } from '../../shared/agent.js';
import { CORE_TOKEN_MINTS } from '../../shared/constants.js';
import { asAppError } from '../errors.js';
import type { FuturesService } from '../futures/futures-service.js';
import type { StockService } from '../stocks-service.js';
import type { TokenService } from '../tokens.js';
import type { TokenInfo } from '../../shared/types.js';
import type { AgentService } from './service.js';
import { agentRequestOutcome } from './outcome.js';
import {
  agentAtomicAmountSchema,
  agentFuturesMarketSchema,
  agentPublicKeySchema,
  agentStockAmountSchema,
  agentStockSymbolSchema,
  agentX402UrlSchema,
} from './schemas.js';

const MCP_BODY_LIMIT = 48 * 1024;
const MCP_REQUESTS_PER_MINUTE = 120;
const MAX_MCP_RATE_BUCKETS = 2_000;

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const tradingAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

interface McpDependencies {
  agents: AgentService;
  tokens: TokenService;
  stocks: StockService;
  futures: FuturesService;
}

interface RateBucket {
  count: number;
  resetAt: number;
}

function safeResult(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function safeToolError(error: unknown): CallToolResult {
  const appError = asAppError(error, 'MCP_TOOL_FAILED');
  const payload = {
    ok: false,
    error: {
      code: appError.code,
      message: appError.message,
      retryable: appError.retryable,
    },
  };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

export function agentRequestResult(request: AgentRequest): CallToolResult {
  return safeResult({
    ok: true,
    request: publicAgentRequest(request),
    ...agentRequestOutcome(request),
  });
}

function publicAgentRequest(request: AgentRequest) {
  const intent = request.intent.kind === 'x402'
    ? {
        kind: request.intent.kind,
        url: request.intent.url,
        method: request.intent.method,
        maxPaymentAtomic: request.intent.maxPaymentAtomic,
      }
    : request.intent;
  return {
    id: request.id,
    status: request.status,
    kind: request.intent.kind,
    intent,
    riskMicroUsd: request.riskUsd,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    approvalMode: request.approvalMode,
    failure: request.failure,
    execution: request.execution,
  };
}

export function selectAgentTokens(tokens: TokenInfo[], query: string): TokenInfo[] {
  const coreRank = new Map<string, number>(CORE_TOKEN_MINTS.map((mint, index) => [mint, index]));
  const exactSymbol = query.trim().toUpperCase();
  const eligible = tokens
    .filter((token) => token.verified && token.tradable)
    .sort((left, right) => {
      const leftExact = left.symbol.toUpperCase() === exactSymbol ? 1 : 0;
      const rightExact = right.symbol.toUpperCase() === exactSymbol ? 1 : 0;
      if (leftExact !== rightExact) return rightExact - leftExact;
      return (coreRank.get(left.mint) ?? Number.MAX_SAFE_INTEGER) - (coreRank.get(right.mint) ?? Number.MAX_SAFE_INTEGER);
    });
  return [...new Map(eligible.map((token) => [token.mint, token])).values()].slice(0, 20);
}

function registerReadTools(server: McpServer, dependencies: McpDependencies, credential: string) {
  server.registerTool('flay_get_capability', {
    title: 'Inspect this Flay capability',
    description: 'Return the authenticated credential’s actual approval mode, wallet, product access, limits, allowlists, and expiry. Use this before proposing a trade to distinguish Full access from Always ask.',
    inputSchema: z.object({}).strict(),
    annotations: readOnlyAnnotations,
  }, async () => {
    try {
      const capability = dependencies.agents.capability(credential);
      return safeResult({
        ok: true,
        capability: {
          id: capability.id,
          name: capability.name,
          wallet: capability.wallet,
          approvalMode: capability.approvalMode,
          status: capability.status,
          products: capability.products,
          maxTransactionUsd: capability.maxTransactionUsd,
          maxDailyUsd: capability.maxDailyUsd,
          maxSlippageBps: capability.maxSlippageBps,
          maxFuturesLeverage: capability.maxFuturesLeverage,
          maxOpenFuturesPositions: capability.maxOpenFuturesPositions,
          allowedTokenMints: capability.allowedTokenMints,
          allowedStockSymbols: capability.allowedStockSymbols,
          allowedFuturesMarkets: capability.allowedFuturesMarkets,
          x402AllowedOrigins: capability.x402AllowedOrigins,
          x402AllowedMethods: capability.x402AllowedMethods,
          maxX402PaymentAtomic: capability.maxX402PaymentAtomic,
          maxX402DailyAtomic: capability.maxX402DailyAtomic,
          createdAt: capability.createdAt,
          expiresAt: capability.expiresAt,
        },
        executionBehavior: capability.approvalMode === 'automatic'
          ? 'Full access: Flay executes policy-compliant requests with the delegated wallet signer; no per-request UI approval is required.'
          : 'Always ask: each request waits for the wallet owner to review and approve it in Flay.',
      });
    } catch (error) {
      return safeToolError(error);
    }
  });

  server.registerTool('flay_list_requests', {
    title: 'List this capability’s Flay requests',
    description: 'List recent requests created by this exact capability, including status, failure, transaction signature, provider, and Explorer URL when available. It cannot read another capability’s requests.',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(50).default(20),
    }).strict(),
    annotations: readOnlyAnnotations,
  }, async ({ limit }) => {
    try {
      const requests = dependencies.agents.recentRequests(credential, limit);
      return safeResult({ ok: true, count: requests.length, requests: requests.map(publicAgentRequest) });
    } catch (error) {
      return safeToolError(error);
    }
  });

  server.registerTool('flay_get_request_status', {
    title: 'Check one Flay request',
    description: 'Return one request owned by this exact capability, its failure or execution evidence, and a fresh Solana confirmation lookup when a transaction signature exists.',
    inputSchema: z.object({
      requestId: z.string().uuid().describe('The Flay request UUID returned by a trading tool.'),
    }).strict(),
    annotations: readOnlyAnnotations,
  }, async ({ requestId }) => {
    try {
      const status = await dependencies.agents.requestStatus(credential, requestId);
      return safeResult({
        ok: true,
        request: publicAgentRequest(status.request),
        confirmation: status.confirmation,
        ...agentRequestOutcome(status.request),
      });
    } catch (error) {
      return safeToolError(error);
    }
  });

  server.registerTool('flay_get_tokens', {
    title: 'Search Flay tokens',
    description: 'Search verified Solana token metadata before constructing a Convert proposal. Returns at most 20 results. This tool never reads a wallet or moves funds.',
    inputSchema: z.object({
      query: z.string().trim().min(1).max(64).describe('Token symbol, name, or exact Solana mint address.'),
    }).strict(),
    annotations: readOnlyAnnotations,
  }, async ({ query }) => {
    try {
      const tokens = selectAgentTokens(await dependencies.tokens.search(query), query).map((token) => ({
        mint: token.mint,
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        tokenProgram: token.tokenProgram,
        verified: token.verified,
        tradable: token.tradable,
        blockedReason: token.blockedReason,
        usdPrice: token.usdPrice,
      }));
      return safeResult({ ok: true, count: tokens.length, tokens });
    } catch (error) {
      return safeToolError(error);
    }
  });

  server.registerTool('flay_get_stocks', {
    title: 'Browse Flay xStocks',
    description: 'Browse a bounded page of official xStocks symbols before constructing a stock proposal. This tool never reads a wallet or moves funds.',
    inputSchema: z.object({
      query: z.string().trim().max(64).optional().describe('Optional symbol, underlying symbol, or company-name filter.'),
      offset: z.number().int().min(0).max(10_000).default(0).describe('Zero-based result offset.'),
      limit: z.number().int().min(1).max(50).default(20).describe('Maximum results, capped at 50.'),
    }).strict(),
    annotations: readOnlyAnnotations,
  }, async ({ query, offset, limit }) => {
    try {
      const catalog = await dependencies.stocks.completeCatalog();
      const needle = query?.toUpperCase();
      const matches = needle
        ? catalog.assets.filter((asset) => `${asset.symbol} ${asset.underlyingSymbol} ${asset.name}`.toUpperCase().includes(needle))
        : catalog.assets;
      const assets = matches.slice(offset, offset + limit).map((asset) => ({
        symbol: asset.symbol,
        underlyingSymbol: asset.underlyingSymbol,
        name: asset.name,
        mint: asset.mint,
        currency: asset.currency,
        exchange: asset.exchange,
        isTradingHalted: asset.isTradingHalted,
        supportsAtomicSwaps: asset.supportsAtomicSwaps,
        referencePrice: asset.referencePrice,
      }));
      return safeResult({
        ok: true,
        provider: catalog.provider,
        status: catalog.status,
        directoryComplete: catalog.directoryComplete,
        totalMatches: matches.length,
        offset,
        count: assets.length,
        hasMore: offset + assets.length < matches.length,
        assets,
        warning: catalog.warning,
      });
    } catch (error) {
      return safeToolError(error);
    }
  });

  server.registerTool('flay_get_futures_markets', {
    title: 'List Flay futures markets',
    description: 'List active Phoenix and GMTrade perpetual markets and bounded public routing data before constructing a Futures proposal. This tool never reads a wallet or moves funds.',
    inputSchema: z.object({}).strict(),
    annotations: readOnlyAnnotations,
  }, async () => {
    try {
      const result = await dependencies.futures.markets();
      const markets = result.markets.slice(0, 20).map((market) => ({
        symbol: market.symbol,
        displayName: market.displayName,
        baseSymbol: market.baseSymbol,
        quoteSymbol: market.quoteSymbol,
        activeVenues: market.activeVenues,
        venues: Object.fromEntries(Object.entries(market.venues).map(([venue, details]) => [venue, details ? {
          active: details.active,
          markPriceMicroUsd: details.markPriceMicroUsd,
          maximumLeverageBps: details.maximumLeverageBps,
          openingFeeBps: details.openingFeeBps,
          fundingRateBpsHourly: details.fundingRateBpsHourly,
          unavailableReason: details.unavailableReason,
          fetchedAt: details.fetchedAt,
        } : null])),
      }));
      return safeResult({ ok: true, count: markets.length, markets, venueReadiness: result.venueReadiness, fetchedAt: result.fetchedAt });
    } catch (error) {
      return safeToolError(error);
    }
  });
}

function registerTradingTools(server: McpServer, dependencies: McpDependencies, credential: string) {
  async function submit(input: AgentIntentSubmission) {
    try {
      return agentRequestResult(await dependencies.agents.submit(credential, input));
    } catch (error) {
      return safeToolError(error);
    }
  }

  server.registerTool('flay_request_convert', {
    title: 'Request a Flay conversion',
    description: 'Submit a policy-checked Convert intent for the credential-bound wallet. amountAtomic is the exact raw input amount using the input mint decimals. Always-ask capabilities queue it for review; automatic capabilities execute it within the owner’s guardrails.',
    inputSchema: z.object({
      idempotencyKey: z.string().uuid().describe('A new UUID for a new request. Reuse the same UUID only when retrying the identical request.'),
      inputMint: agentPublicKeySchema.describe('Allowed Solana input mint.'),
      outputMint: agentPublicKeySchema.describe('Allowed Solana output mint.'),
      amountAtomic: agentAtomicAmountSchema.describe('Exact raw input amount in the input mint atomic units.'),
      slippageBps: z.number().int().min(1).max(500).describe('Maximum slippage in basis points; 50 means 0.50%.'),
    }).strict().refine((value) => value.inputMint !== value.outputMint, { path: ['outputMint'], message: 'Choose different tokens.' }),
    annotations: tradingAnnotations,
  }, (input) => submit({ idempotencyKey: input.idempotencyKey, intent: { kind: 'convert', inputMint: input.inputMint, outputMint: input.outputMint, amountAtomic: input.amountAtomic, slippageBps: input.slippageBps } }));

  server.registerTool('flay_request_stock_trade', {
    title: 'Request an xStocks trade',
    description: 'Submit a policy-checked xStocks buy or sell intent. For buys, amount is display USDC; for sells, amount is display xStock units. Behavior follows the owner-selected approval mode.',
    inputSchema: z.object({
      idempotencyKey: z.string().uuid().describe('A new UUID for a new request. Reuse it only for an identical retry.'),
      symbol: agentStockSymbolSchema.describe('Allowed official xStocks provider symbol, for example AAPLX.'),
      side: z.enum(['buy', 'sell']),
      amount: agentStockAmountSchema.describe('Display USDC amount for buy or display xStock units for sell.'),
      slippageBps: z.number().int().min(1).max(500).describe('Maximum slippage in basis points.'),
    }).strict(),
    annotations: tradingAnnotations,
  }, (input) => submit({ idempotencyKey: input.idempotencyKey, intent: { kind: 'stock', symbol: input.symbol, side: input.side, amount: input.amount, slippageBps: input.slippageBps } }));

  server.registerTool('flay_request_futures_open', {
    title: 'Request a Futures position',
    description: 'Submit a policy-checked Phoenix/GMTrade perpetual intent. collateralAtomic uses six-decimal USDC atomic units and leverageBps uses 10000 per 1×. Behavior follows the owner-selected approval mode.',
    inputSchema: z.object({
      idempotencyKey: z.string().uuid().describe('A new UUID for a new request. Reuse it only for an identical retry.'),
      market: agentFuturesMarketSchema,
      side: z.enum(['long', 'short']),
      orderType: z.enum(['market', 'limit']),
      collateralAtomic: agentAtomicAmountSchema.refine((value) => BigInt(value) >= 1_000_000n, 'Minimum collateral is 1 USDC.').describe('USDC collateral in six-decimal atomic units; 1000000 means 1 USDC.'),
      leverageBps: z.number().int().min(10_000).max(100_000).describe('Leverage in basis points; 30000 means 3×.'),
      limitPriceMicroUsd: agentAtomicAmountSchema.optional().describe('Required only for limit orders; USD price in six-decimal micro-USD.'),
      slippageBps: z.number().int().min(1).max(500).describe('Maximum slippage in basis points.'),
      routeChoice: z.enum(['auto', 'phoenix', 'gmtrade']).default('auto').describe('Use auto for Flay best-route selection or name an allowed venue.'),
    }).strict().superRefine((value, context) => {
      if (value.orderType === 'limit' && !value.limitPriceMicroUsd) context.addIssue({ code: 'custom', path: ['limitPriceMicroUsd'], message: 'Limit price is required.' });
      if (value.orderType === 'market' && value.limitPriceMicroUsd) context.addIssue({ code: 'custom', path: ['limitPriceMicroUsd'], message: 'Market orders cannot include a limit price.' });
    }),
    annotations: tradingAnnotations,
  }, (input) => submit({
    idempotencyKey: input.idempotencyKey,
    intent: {
      kind: 'futures-open', market: input.market, side: input.side, orderType: input.orderType,
      collateralAtomic: input.collateralAtomic, leverageBps: input.leverageBps,
      ...(input.limitPriceMicroUsd ? { limitPriceMicroUsd: input.limitPriceMicroUsd } : {}),
      slippageBps: input.slippageBps, routeChoice: input.routeChoice,
    },
  }));

  server.registerTool('flay_request_futures_manage', {
    title: 'Request a Futures close or cancel',
    description: 'Submit a policy-checked request to close an existing position or cancel an existing order using its exact provider native ID. Behavior follows the owner-selected approval mode.',
    inputSchema: z.object({
      idempotencyKey: z.string().uuid().describe('A new UUID for a new request. Reuse it only for an identical retry.'),
      action: z.enum(['close', 'cancel']),
      venue: z.enum(['phoenix', 'gmtrade']),
      market: agentFuturesMarketSchema,
      nativeId: z.string().min(1).max(128).describe('Exact venue position ID for close or order ID for cancel.'),
    }).strict(),
    annotations: tradingAnnotations,
  }, (input) => submit({ idempotencyKey: input.idempotencyKey, intent: { kind: 'futures-manage', action: input.action, venue: input.venue, market: input.market, nativeId: input.nativeId } }));

  server.registerTool('flay_request_x402', {
    title: 'Pay for an x402 HTTP resource',
    description: 'Request a bounded x402 v2 exact-USDC payment to an owner-allowlisted HTTPS API. Flay first reads the 402 challenge, validates Solana mainnet, canonical USDC, price, recipient, fee payer, and transaction instructions, then follows the capability approval mode. Poll flay_get_request_status for the paid response and settlement receipt.',
    inputSchema: z.object({
      idempotencyKey: z.string().uuid().describe('A new UUID for a new paid request. Reuse it only for an identical retry.'),
      url: agentX402UrlSchema.describe('Complete allowlisted HTTPS resource URL. Credentials, fragments, redirects, custom ports, and private destinations are rejected.'),
      method: z.enum(['GET', 'POST']).default('GET').describe('HTTP method allowed by the owner capability.'),
      body: z.record(z.string().min(1).max(128), z.unknown()).optional().describe('Optional JSON object for POST, limited to 8 KiB. GET cannot include a body.'),
      maxPaymentAtomic: agentAtomicAmountSchema.describe('Caller ceiling in atomic USDC. USDC has six decimals, so 1 equals 0.000001 USDC.'),
    }).strict().superRefine((value, context) => {
      if (value.method === 'GET' && value.body !== undefined) context.addIssue({ code: 'custom', path: ['body'], message: 'GET x402 requests cannot include a body.' });
      if (value.body !== undefined && Buffer.byteLength(JSON.stringify(value.body), 'utf8') > 8 * 1024) context.addIssue({ code: 'custom', path: ['body'], message: 'The x402 JSON body must be at most 8 KiB.' });
    }),
    annotations: tradingAnnotations,
  }, (input) => submit({
    idempotencyKey: input.idempotencyKey,
    intent: {
      kind: 'x402',
      url: input.url,
      method: input.method,
      ...(input.body === undefined ? {} : { body: input.body }),
      maxPaymentAtomic: input.maxPaymentAtomic,
    },
  }));
}

function createFlayMcpServer(dependencies: McpDependencies, credential: string) {
  const server = new McpServer({ name: 'flay', version: '1.0.0' });
  registerReadTools(server, dependencies, credential);
  registerTradingTools(server, dependencies, credential);
  return server;
}

function bearerCredential(request: Request): string | undefined {
  const value = request.header('authorization');
  const match = value?.match(/^Bearer ([^\s]{1,256})$/i);
  return match?.[1];
}

function requestOriginAllowed(request: Request): boolean {
  const origin = request.header('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === request.get('host');
  } catch {
    return false;
  }
}

function rpcError(response: Response, status: number, code: number, message: string, dataCode: string, retryable = false) {
  if (status === 401) response.setHeader('www-authenticate', 'Bearer realm="Flay MCP"');
  response.status(status).json({ jsonrpc: '2.0', error: { code, message, data: { code: dataCode, retryable } }, id: null });
}

export function mountAgentMcp(router: Router, dependencies: McpDependencies) {
  const buckets = new Map<string, RateBucket>();
  const handler = createMcpHandler((context) => createFlayMcpServer(dependencies, context.authInfo?.token ?? ''), {
    legacy: 'stateless',
    responseMode: 'json',
    maxRequestBodySize: MCP_BODY_LIMIT,
    maxSubscriptions: 0,
    keepAliveMs: 0,
  });
  const nodeHandler = toNodeHandler(handler, { maxRequestBodySize: MCP_BODY_LIMIT });

  router.all('/mcp', async (request, response) => {
    if (!requestOriginAllowed(request)) {
      rpcError(response, 403, -32_000, 'Origin rejected.', 'ORIGIN_REJECTED');
      return;
    }
    const rawCredential = bearerCredential(request);
    let principal: ReturnType<AgentService['authorizeCapability']>;
    try {
      principal = dependencies.agents.authorizeCapability(rawCredential);
    } catch (error) {
      const appError = asAppError(error, 'MCP_AUTH_FAILED');
      rpcError(response, appError.status, -32_001, appError.message, appError.code, appError.retryable);
      return;
    }

    const now = Date.now();
    if (!buckets.has(principal.id) && buckets.size >= MAX_MCP_RATE_BUCKETS) {
      for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
      if (buckets.size >= MAX_MCP_RATE_BUCKETS) buckets.delete(buckets.keys().next().value!);
    }
    const current = buckets.get(principal.id);
    const bucket = !current || current.resetAt <= now ? { count: 0, resetAt: now + 60_000 } : current;
    bucket.count += 1;
    buckets.set(principal.id, bucket);
    response.setHeader('x-ratelimit-limit', String(MCP_REQUESTS_PER_MINUTE));
    response.setHeader('x-ratelimit-remaining', String(Math.max(0, MCP_REQUESTS_PER_MINUTE - bucket.count)));
    if (bucket.count > MCP_REQUESTS_PER_MINUTE) {
      rpcError(response, 429, -32_029, 'Too many MCP requests. Wait one minute.', 'MCP_RATE_LIMITED', true);
      return;
    }

    if (!['POST', 'GET', 'DELETE'].includes(request.method)) {
      response.setHeader('allow', 'POST, GET, DELETE');
      rpcError(response, 405, -32_000, 'Method not allowed.', 'MCP_METHOD_NOT_ALLOWED');
      return;
    }

    const authenticatedRequest = request as Request & { auth?: { token: string; clientId: string; scopes: string[]; expiresAt: number } };
    authenticatedRequest.auth = {
      token: rawCredential!,
      clientId: `flay-agent:${principal.id}`,
      scopes: ['flay:discover', ...principal.products.map((product) => `flay:request:${product}`)],
      expiresAt: Math.floor(principal.expiresAt / 1_000),
    };
    await nodeHandler(authenticatedRequest, response);
  });
}
