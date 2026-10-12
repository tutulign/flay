import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { ActivityService } from './activity-service.js';
import { assertIdentityWallet, requireIdentity } from './auth.js';
import { config, rpcProviderLabel, serverReadiness } from './config.js';
import { AppError, asyncRoute, errorHandler, notFoundHandler } from './errors.js';
import { EphemeralStore } from './prepared-store.js';
import { MagicBlockService } from './magicblock-service.js';
import { QuoteService } from './quote-service.js';
import { FuturesService } from './futures/futures-service.js';
import { FuturesTransactionService, futuresTransactionDiagnostics } from './futures/transaction-service.js';
import { AlchemyPayService } from './alchemy-pay-service.js';
import { GaslessUsdcSendService } from './gasless-usdc-send-service.js';
import { StockService } from './stocks-service.js';
import { AgentService } from './agent/service.js';
import { mountAgentMcp } from './agent/mcp.js';
import { agentRequestOutcome } from './agent/outcome.js';
import {
  agentExecuteSchema,
  agentIntentSubmissionSchema,
  agentPolicySchema,
  agentRequestActionSchema,
  agentSponsoredCompleteSchema,
  agentWorkspaceSchema,
} from './agent/schemas.js';
import {
  activitySchema,
  alchemyPayCheckoutSchema,
  alchemyPayOrderSchema,
  alchemyPayOrdersSchema,
  executeSchema,
  futuresCandlesSchema,
  futuresExecuteSchema,
  futuresExecutionQuerySchema,
  futuresPhoenixChallengeSchema,
  futuresPhoenixLoginSchema,
  futuresPrepareSchema,
  futuresQuoteSchema,
  gaslessUsdcSendPrepareSchema,
  gaslessUsdcSendStatusSchema,
  magicBlockExecuteSchema,
  magicBlockLoginSchema,
  magicBlockPrepareSchema,
  magicBlockWalletSchema,
  prepareSchema,
  quoteSchema,
  sponsoredMarketCompleteSchema,
  stockQuoteSchema,
  stockPricesSchema,
  stockSymbolSchema,
  tokenSearchSchema,
  triggerCancelSchema,
  triggerCreateSchema,
  triggerOrdersSchema,
  walletSchema,
} from './schemas.js';
import { TokenService } from './tokens.js';
import { TriggerService } from './trigger-service.js';

function sameOrigin(request: Request, _response: Response, next: NextFunction) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return next();
  const origin = request.header('origin');
  if (!origin) return next();
  try {
    const originHost = new URL(origin).host;
    if (originHost !== request.get('host')) {
      return next(new AppError(403, 'ORIGIN_REJECTED', 'This request did not originate from Flay.'));
    }
  } catch {
    return next(new AppError(403, 'ORIGIN_REJECTED', 'This request has an invalid origin.'));
  }
  return next();
}

function securityHeaders(_request: Request, response: Response, next: NextFunction) {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('cache-control', 'no-store');
  next();
}

function rateLimit(maximum: number, windowMs: number) {
  const clients = new Map<string, { resetAt: number; count: number }>();
  let requestsSinceSweep = 0;
  return (request: Request, response: Response, next: NextFunction) => {
    const key = request.ip ?? 'unknown';
    const now = Date.now();
    requestsSinceSweep += 1;
    if (requestsSinceSweep >= 256) {
      for (const [client, bucket] of clients) if (bucket.resetAt <= now) clients.delete(client);
      requestsSinceSweep = 0;
    }
    if (!clients.has(key) && clients.size >= 10_000) {
      const oldest = clients.keys().next().value as string | undefined;
      if (oldest) clients.delete(oldest);
    }
    const current = clients.get(key);
    const bucket = !current || current.resetAt <= now ? { resetAt: now + windowMs, count: 0 } : current;
    bucket.count += 1;
    clients.set(key, bucket);
    response.setHeader('x-ratelimit-limit', String(maximum));
    response.setHeader('x-ratelimit-remaining', String(Math.max(0, maximum - bucket.count)));
    if (bucket.count > maximum) {
      return next(new AppError(429, 'RATE_LIMITED', 'Too many requests. Wait a moment and retry.', true));
    }
    return next();
  };
}

export function createApiRouter(): Router {
  const router = Router();
  const store = new EphemeralStore();
  const tokens = new TokenService();
  const quotes = new QuoteService(tokens, store);
  const trigger = new TriggerService(tokens, store);
  const activity = new ActivityService(tokens);
  const magicBlock = new MagicBlockService(tokens);
  const futures = new FuturesService(tokens);
  const futuresTransactions = new FuturesTransactionService(futures);
  const alchemyPay = new AlchemyPayService();
  const gaslessUsdcSend = new GaslessUsdcSendService(tokens);
  const stocks = new StockService(tokens, quotes);
  const agents = new AgentService(tokens, quotes, stocks, futures, futuresTransactions);

  router.use(securityHeaders);
  mountAgentMcp(router, { agents, tokens, stocks, futures });
  router.use(sameOrigin);
  router.use(express.json({ limit: '24kb', strict: true }));

  router.get('/health', rateLimit(30, 60_000), asyncRoute(async (_request, response) => {
    const [futuresReadiness, magicBlockReadiness, stocksReadiness] = await Promise.all([
      futures.diagnostics(),
      magicBlock.status(),
      stocks.diagnostics(),
    ]);
    const readiness = {
      ...serverReadiness(),
      magicBlock: magicBlockReadiness.available
        && magicBlockReadiness.mintInitialized
        && magicBlockReadiness.privateTransfers,
      xstocks: stocksReadiness.available,
      x402Payer: true,
    };
    response.json({
      status: futuresReadiness.rpc.available && futuresReadiness.simulation.available && futuresReadiness.phoenixPublic.publicData && futuresReadiness.gmtrade.publicData && stocksReadiness.available ? 'ok' : 'degraded',
      network: 'solana-mainnet-beta',
      readiness,
      magicBlockReadiness,
      stocksReadiness,
      futuresReadiness: {
        ...futuresReadiness,
        phoenixExecution: { walletBound: true, detail: 'Onchain onboarding capabilities are checked per authenticated wallet.' },
        transactions: futuresTransactionDiagnostics(),
      },
      providers: {
        authentication: 'Privy',
        market: ['Jupiter Swap V2', 'Raydium Trade API', 'Orca Whirlpools SDK'],
        limit: 'Jupiter Trigger V1',
        magicBlock: 'MagicBlock Ephemeral SPL Token',
        futures: ['Phoenix', 'GMTrade'],
        futuresChart: 'TradingView Lightweight Charts · Phoenix reference candles',
        rpc: rpcProviderLabel(),
        fiatOnRamp: 'Privy Card Onramps',
        stocks: ['xStocks', 'Jupiter Swap V2 Router'],
        agentAccess: 'Flay user-selectable approval or delegated capability API',
        agentMcp: 'Model Context Protocol · Streamable HTTP · /api/mcp',
        agentPayments: 'x402 v2 exact · Solana mainnet USDC payer',
      },
      gasless: {
        scope: 'eligible-market-swaps-and-usdc-send',
        providers: ['Jupiter', 'Privy'],
        integratorSponsor: false,
        privyManagedSponsor: true,
        detail: 'Jupiter sponsors eligible Jupiter orders. Privy sponsors eligible reviewed Raydium/Orca SPL swaps and the reviewed USDC send flow.',
      },
      privyFiatOnramp: {
        provider: 'Privy',
        environment: config.privyFiatOnrampEnvironment,
        asset: 'USDC',
        network: 'SOL',
        supportedFiat: ['USD', 'EUR', 'AUD', 'BRL'],
        dashboardActivation: 'required',
      },
      // Dormant fallback metadata. The shipped Funds page does not call these routes.
      alchemyPay: alchemyPay.capability(),
    });
  }));

  router.get('/agent/workspace', requireIdentity, rateLimit(30, 60_000), asyncRoute(async (request, response) => {
    const { wallet } = agentWorkspaceSchema.parse(request.query);
    assertIdentityWallet(request, wallet);
    response.json(agents.workspace(request.flayIdentity!.userId, wallet));
  }));

  router.post('/agent/credentials', requireIdentity, rateLimit(5, 60_000), asyncRoute(async (request, response) => {
    const input = agentPolicySchema.parse(request.body);
    assertIdentityWallet(request, input.wallet);
    const { wallet, ...policy } = input;
    response.status(201).json(await agents.createCredentialForIdentity(request.flayIdentity!.userId, wallet, policy));
  }));

  router.post('/agent/credentials/:id/revoke', requireIdentity, rateLimit(10, 60_000), asyncRoute(async (request, response) => {
    const { wallet } = agentRequestActionSchema.parse(request.body);
    assertIdentityWallet(request, wallet);
    const id = Array.isArray(request.params.id) ? request.params.id[0] : request.params.id;
    response.json({ credential: agents.revoke(request.flayIdentity!.userId, wallet, id) });
  }));

  router.post('/agent/requests', rateLimit(30, 60_000), asyncRoute(async (request, response) => {
    const submittedKind = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      && 'intent' in request.body && request.body.intent && typeof request.body.intent === 'object' && !Array.isArray(request.body.intent)
      && 'kind' in request.body.intent ? request.body.intent.kind : undefined;
    if (typeof submittedKind === 'string' && !['convert', 'stock', 'futures-open', 'futures-manage'].includes(submittedKind)) {
      throw new AppError(403, 'AGENT_ACTION_NOT_ALLOWED', 'This capability supports only Convert, xStocks, and Futures requests. Fiat funding and general wallet actions are unavailable.');
    }
    const input = agentIntentSubmissionSchema.parse(request.body);
    const authorization = request.header('authorization');
    const credential = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    const agentRequest = await agents.submit(credential, input);
    const acceptedForLater = agentRequest.status === 'pending' || agentRequest.status === 'prepared';
    response.status(acceptedForLater ? 202 : 200).json({
      request: agentRequest,
      ...agentRequestOutcome(agentRequest),
    });
  }));

  router.post('/agent/requests/:id/review', requireIdentity, rateLimit(12, 60_000), asyncRoute(async (request, response) => {
    const { wallet } = agentRequestActionSchema.parse(request.body);
    assertIdentityWallet(request, wallet);
    const id = Array.isArray(request.params.id) ? request.params.id[0] : request.params.id;
    response.json(await agents.review(request.flayIdentity!.userId, wallet, id));
  }));

  router.post('/agent/requests/:id/reject', requireIdentity, rateLimit(20, 60_000), asyncRoute(async (request, response) => {
    const { wallet } = agentRequestActionSchema.parse(request.body);
    assertIdentityWallet(request, wallet);
    const id = Array.isArray(request.params.id) ? request.params.id[0] : request.params.id;
    response.json({ request: agents.reject(request.flayIdentity!.userId, wallet, id) });
  }));

  router.post('/agent/requests/:id/execute', requireIdentity, rateLimit(12, 60_000), asyncRoute(async (request, response) => {
    const input = agentExecuteSchema.parse(request.body);
    assertIdentityWallet(request, input.wallet);
    const id = Array.isArray(request.params.id) ? request.params.id[0] : request.params.id;
    response.json(await agents.execute(request.flayIdentity!.userId, input.wallet, id, input.signedTransaction, input.idempotencyKey));
  }));

  router.post('/agent/requests/:id/complete-sponsored', requireIdentity, rateLimit(12, 60_000), asyncRoute(async (request, response) => {
    const input = agentSponsoredCompleteSchema.parse(request.body);
    assertIdentityWallet(request, input.wallet);
    const id = Array.isArray(request.params.id) ? request.params.id[0] : request.params.id;
    response.json(await agents.completeSponsored(request.flayIdentity!.userId, input.wallet, id, input.signature));
  }));

  router.get('/fiat/capability', rateLimit(30, 60_000), asyncRoute(async (_request, response) => {
    response.json(alchemyPay.capability());
  }));

  router.post('/fiat/checkout', requireIdentity, rateLimit(10, 60_000), asyncRoute(async (request, response) => {
    const input = alchemyPayCheckoutSchema.parse(request.body);
    assertIdentityWallet(request, input.wallet);
    response.status(201).json(await alchemyPay.createCheckout(input, request.flayIdentity!.userId));
  }));

  router.get('/fiat/orders', requireIdentity, rateLimit(30, 60_000), asyncRoute(async (request, response) => {
    const { wallet } = alchemyPayOrdersSchema.parse(request.query);
    assertIdentityWallet(request, wallet);
    response.json({ orders: await alchemyPay.list(wallet, request.flayIdentity!.userId) });
  }));

  router.get('/fiat/orders/:merchantOrderNo', requireIdentity, rateLimit(30, 60_000), asyncRoute(async (request, response) => {
    const merchantOrderNo = Array.isArray(request.params.merchantOrderNo) ? request.params.merchantOrderNo[0] : request.params.merchantOrderNo;
    const input = alchemyPayOrderSchema.parse({ wallet: request.query.wallet, merchantOrderNo });
    assertIdentityWallet(request, input.wallet);
    response.json({ order: await alchemyPay.get(input.merchantOrderNo, input.wallet, request.flayIdentity!.userId) });
  }));

  router.post('/fiat/orders/:merchantOrderNo/refresh', requireIdentity, rateLimit(10, 60_000), asyncRoute(async (request, response) => {
    const merchantOrderNo = Array.isArray(request.params.merchantOrderNo) ? request.params.merchantOrderNo[0] : request.params.merchantOrderNo;
    const input = alchemyPayOrderSchema.parse({ wallet: request.body?.wallet, merchantOrderNo });
    assertIdentityWallet(request, input.wallet);
    response.json({ order: await alchemyPay.refresh(input.merchantOrderNo, input.wallet, request.flayIdentity!.userId) });
  }));

  router.post('/fiat/alchemy-pay/webhook', rateLimit(120, 60_000), asyncRoute(async (request, response) => {
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body) || Object.keys(request.body).length > 80) {
      throw new AppError(400, 'ALCHEMY_PAY_WEBHOOK_INVALID', 'The Alchemy Pay callback body is invalid.');
    }
    await alchemyPay.webhook(request.body as Record<string, unknown>, request.header('timestamp'));
    response.status(200).type('text/plain').send('success');
  }));

  router.get('/futures/markets', rateLimit(60, 60_000), asyncRoute(async (_request, response) => {
    response.json(await futures.markets());
  }));

  router.get('/futures/candles', rateLimit(60, 60_000), asyncRoute(async (request, response) => {
    const input = futuresCandlesSchema.parse(request.query);
    response.json(await futures.candles(input.symbol, input.interval));
  }));

  router.post('/futures/quotes', requireIdentity, rateLimit(60, 60_000), asyncRoute(async (request, response) => {
    const input = futuresQuoteSchema.parse(request.body);
    assertIdentityWallet(request, input.wallet);
    response.json(await futures.routeQuotes(input));
  }));

  router.get('/futures/portfolio', requireIdentity, rateLimit(60, 60_000), asyncRoute(async (request, response) => {
    const { wallet } = walletSchema.parse(request.query);
    assertIdentityWallet(request, wallet);
    response.json(await futures.portfolio(wallet));
  }));

  router.get('/futures/phoenix/access', requireIdentity, rateLimit(30, 60_000), asyncRoute(async (request, response) => {
    const { wallet } = walletSchema.parse(request.query);
    assertIdentityWallet(request, wallet);
    response.json(await futures.access(wallet));
  }));


  router.post('/futures/phoenix/auth/challenge', requireIdentity, rateLimit(10, 60_000), asyncRoute(async (request, response) => {
    const { wallet } = futuresPhoenixChallengeSchema.parse(request.body);
    assertIdentityWallet(request, wallet);
    response.json(await futuresTransactions.challengePhoenix(wallet));
  }));

  router.post('/futures/phoenix/auth/login', requireIdentity, rateLimit(10, 60_000), asyncRoute(async (request, response) => {
    const { wallet, challengeId, signedTransaction } = futuresPhoenixLoginSchema.parse(request.body);
    assertIdentityWallet(request, wallet);
    const proof = challengeId && signedTransaction ? { challengeId, signedTransaction } : undefined;
    response.json(await futuresTransactions.loginPhoenix(wallet, proof));
  }));

  router.post('/futures/prepare', requireIdentity, rateLimit(20, 60_000), asyncRoute(async (request, response) => {
    const input = futuresPrepareSchema.parse(request.body);
    assertIdentityWallet(request, input.wallet);
    response.json(await futuresTransactions.prepare(input));
  }));

  router.post('/futures/execute', requireIdentity, rateLimit(20, 60_000), asyncRoute(async (request, response) => {
    const input = futuresExecuteSchema.parse(request.body);
    assertIdentityWallet(request, input.wallet);
    response.json(await futuresTransactions.execute(input.preparedId, input.wallet, input.signedTransaction, input.idempotencyKey));
  }));

  router.get('/futures/execution/:id', requireIdentity, rateLimit(60, 60_000), asyncRoute(async (request, response) => {
    const { wallet } = futuresExecutionQuerySchema.parse(request.query);
    assertIdentityWallet(request, wallet);
    const executionId = Array.isArray(request.params.id) ? request.params.id[0] : request.params.id;
    response.json(await futuresTransactions.execution(executionId, wallet));
  }));

  router.get('/tokens', rateLimit(60, 60_000), asyncRoute(async (request, response) => {
    const { query } = tokenSearchSchema.parse(request.query);
    response.json({ tokens: await tokens.search(query) });
  }));

  router.get('/stocks', rateLimit(30, 60_000), asyncRoute(async (_request, response) => {
    response.json(await stocks.catalog());
  }));

  router.get('/stocks/:symbol', rateLimit(60, 60_000), asyncRoute(async (request, response) => {
    const symbol = stockSymbolSchema.parse(Array.isArray(request.params.symbol) ? request.params.symbol[0] : request.params.symbol);
    response.json({ asset: await stocks.detail(symbol) });
  }));

  router.get('/stocks-prices', rateLimit(30, 60_000), asyncRoute(async (request, response) => {
    const { symbols } = stockPricesSchema.parse(request.query);
    response.json(await stocks.referencePrices(symbols));
  }));

  router.post('/stocks/quotes', requireIdentity, rateLimit(40, 60_000), asyncRoute(async (request, response) => {
    const input = stockQuoteSchema.parse(request.body);
    assertIdentityWallet(request, input.wallet);
    response.json(await stocks.quote(input));
  }));

  router.get('/tokens/:mint', rateLimit(60, 60_000), asyncRoute(async (request, response) => {
    response.json({ token: await tokens.getByMint(Array.isArray(request.params.mint) ? request.params.mint[0] : request.params.mint) });
  }));

  router.get('/quotes', rateLimit(60, 60_000), asyncRoute(async (request, response) => {
    const input = quoteSchema.parse(request.query);
    response.json(await quotes.quotes(input));
  }));

  router.get('/balances', requireIdentity, rateLimit(60, 60_000), asyncRoute(async (request, response) => {
    const { wallet } = walletSchema.parse(request.query);
    assertIdentityWallet(request, wallet);
    response.json(await tokens.balances(wallet));
  }));

  router.post('/transfers/usdc/prepare', requireIdentity, rateLimit(6, 60_000), asyncRoute(async (request, response) => {
    const input = gaslessUsdcSendPrepareSchema.parse(request.body);
    assertIdentityWallet(request, input.wallet);
    response.json(await gaslessUsdcSend.prepare(input));
  }));

  router.post('/transfers/usdc/status', requireIdentity, rateLimit(30, 60_000), asyncRoute(async (request, response) => {
    const input = gaslessUsdcSendStatusSchema.parse(request.body);
    assertIdentityWallet(request, input.wallet);
    response.json(await gaslessUsdcSend.status(input));
  }));

  router.get('/magicblock/status', rateLimit(30, 60_000), asyncRoute(async (_request, response) => {
    response.json(await magicBlock.status());
  }));

  router.get('/magicblock/challenge', requireIdentity, rateLimit(10, 60_000), asyncRoute(async (request, response) => {
    const { wallet } = magicBlockWalletSchema.parse(request.query);
    assertIdentityWallet(request, wallet);
    response.json(await magicBlock.challenge(wallet));
  }));

  router.post('/magicblock/login', requireIdentity, rateLimit(10, 60_000), asyncRoute(async (request, response) => {
    const input = magicBlockLoginSchema.parse(request.body);
    assertIdentityWallet(request, input.wallet);
    response.json(await magicBlock.login(input.wallet, input.challenge, input.signature));
  }));

  router.get('/magicblock/balance', requireIdentity, rateLimit(30, 60_000), asyncRoute(async (request, response) => {
    const { wallet } = magicBlockWalletSchema.parse(request.query);
    assertIdentityWallet(request, wallet);
    response.json(await magicBlock.balance(wallet));
  }));

  router.post('/magicblock/prepare', requireIdentity, rateLimit(20, 60_000), asyncRoute(async (request, response) => {
    const input = magicBlockPrepareSchema.parse(request.body);
    assertIdentityWallet(request, input.wallet);
    response.json(await magicBlock.prepare(input));
  }));

  router.post('/magicblock/execute', requireIdentity, rateLimit(20, 60_000), asyncRoute(async (request, response) => {
    const input = magicBlockExecuteSchema.parse(request.body);
    assertIdentityWallet(request, input.wallet);
    response.json(await magicBlock.execute(input.preparedId, input.wallet, input.signedTransaction));
  }));

  router.post('/market/prepare', requireIdentity, rateLimit(30, 60_000), asyncRoute(async (request, response) => {
    const { quoteId, wallet } = prepareSchema.parse(request.body);
    assertIdentityWallet(request, wallet);
    response.json(await quotes.prepare(quoteId, wallet));
  }));

  router.post('/transactions/execute', requireIdentity, rateLimit(30, 60_000), asyncRoute(async (request, response) => {
    const { preparedId, signedTransaction } = executeSchema.parse(request.body);
    const record = store.getPrepared(preparedId);
    assertIdentityWallet(request, record.wallet);
    response.json(await quotes.execute(preparedId, signedTransaction));
  }));

  router.post('/transactions/sponsored/complete', requireIdentity, rateLimit(12, 60_000), asyncRoute(async (request, response) => {
    const { preparedId, signature } = sponsoredMarketCompleteSchema.parse(request.body);
    const record = store.getPrepared(preparedId);
    assertIdentityWallet(request, record.wallet);
    response.json(await quotes.completePrivySponsored(preparedId, signature));
  }));

  router.get('/activity/:signature', requireIdentity, rateLimit(120, 60_000), asyncRoute(async (request, response) => {
    const input = activitySchema.parse({ wallet: request.query.wallet, signature: request.params.signature });
    assertIdentityWallet(request, input.wallet);
    response.json(await activity.get(input.wallet, input.signature));
  }));

  router.post('/trigger/create', requireIdentity, rateLimit(20, 60_000), asyncRoute(async (request, response) => {
    const input = triggerCreateSchema.parse(request.body);
    assertIdentityWallet(request, input.wallet);
    response.json(await trigger.create(input));
  }));

  router.get('/trigger/orders', requireIdentity, rateLimit(60, 60_000), asyncRoute(async (request, response) => {
    const input = triggerOrdersSchema.parse(request.query);
    assertIdentityWallet(request, input.wallet);
    response.json(await trigger.list(input.wallet, input.orderStatus, input.page));
  }));

  router.post('/trigger/cancel', requireIdentity, rateLimit(20, 60_000), asyncRoute(async (request, response) => {
    const input = triggerCancelSchema.parse(request.body);
    assertIdentityWallet(request, input.wallet);
    response.json(await trigger.cancel(input.wallet, input.order));
  }));

  router.use(notFoundHandler);
  router.use(errorHandler);
  return router;
}
