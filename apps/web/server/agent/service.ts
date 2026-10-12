import type { AgentExecutionResponse, AgentIntent, AgentIntentSubmission, AgentPolicyInput, AgentRequest, AgentReviewResponse, AgentX402PreparedPayment } from '../../shared/agent.js';
import type { FuturesIntent, FuturesRouteQuote } from '../../shared/futures.js';
import { decimalToAtomic } from '../../shared/amounts.js';
import { AppError, asAppError } from '../errors.js';
import type { FuturesService } from '../futures/futures-service.js';
import type { FuturesTransactionService } from '../futures/transaction-service.js';
import { prepareRankedMarketRoute } from '../market-route-fallback.js';
import type { QuoteService } from '../quote-service.js';
import type { StockService } from '../stocks-service.js';
import type { TokenService } from '../tokens.js';
import { withRpcFallback } from '../rpc.js';
import { PrivyAgentDelegatedSigner, type AgentDelegatedSigner } from './delegated-signer.js';
import { AgentStore, type AgentCredentialRecord, type AgentRequestRecord } from './store.js';
import { AgentX402Service, type AgentX402Payments } from './x402-service.js';

const MICRO_USD = 1_000_000n;

function usdToMicro(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) throw new AppError(400, 'AGENT_VALUE_INVALID', 'The request value is invalid.');
  return BigInt(Math.ceil(value * Number(MICRO_USD)));
}

function microToUsd(value: bigint): string {
  return value.toString();
}

function product(intent: AgentIntent): 'convert' | 'stocks' | 'futures' | 'x402' {
  if (intent.kind === 'convert') return 'convert';
  if (intent.kind === 'stock') return 'stocks';
  if (intent.kind === 'x402') return 'x402';
  return 'futures';
}

function assertPolicyBasics(policy: AgentPolicyInput, intent: AgentIntent) {
  const requestedProduct = product(intent);
  if (!policy.products.includes(requestedProduct)) throw new AppError(403, 'AGENT_PRODUCT_DENIED', `${requestedProduct} is disabled for this agent.`);
  if ('slippageBps' in intent && intent.slippageBps > policy.maxSlippageBps) {
    throw new AppError(403, 'AGENT_SLIPPAGE_LIMIT', `This request exceeds the ${policy.maxSlippageBps / 100}% slippage guardrail.`);
  }
  if (intent.kind === 'convert' && (!policy.allowedTokenMints.includes(intent.inputMint) || !policy.allowedTokenMints.includes(intent.outputMint))) {
    throw new AppError(403, 'AGENT_TOKEN_DENIED', 'This token pair is outside the agent allowlist.');
  }
  if (intent.kind === 'stock' && !policy.allowedStockSymbols.includes(intent.symbol.toUpperCase())) {
    throw new AppError(403, 'AGENT_STOCK_DENIED', 'This xStock is outside the agent allowlist.');
  }
  if ((intent.kind === 'futures-open' || intent.kind === 'futures-manage') && !policy.allowedFuturesMarkets.includes(intent.market)) {
    throw new AppError(403, 'AGENT_FUTURES_MARKET_DENIED', 'This futures market is outside the agent allowlist.');
  }
  if (intent.kind === 'futures-open' && intent.leverageBps > policy.maxFuturesLeverage * 10_000) {
    throw new AppError(403, 'AGENT_LEVERAGE_LIMIT', `This request exceeds the ${policy.maxFuturesLeverage}× leverage guardrail.`);
  }
  if (intent.kind === 'x402') {
    const origin = new URL(intent.url).origin;
    if (!policy.x402AllowedOrigins.includes(origin)) throw new AppError(403, 'AGENT_X402_ORIGIN_DENIED', 'This x402 service origin is outside the agent allowlist.');
    if (!policy.x402AllowedMethods.includes(intent.method)) throw new AppError(403, 'AGENT_X402_METHOD_DENIED', `This capability does not allow x402 ${intent.method} requests.`);
    if (BigInt(intent.maxPaymentAtomic) > BigInt(policy.maxX402PaymentAtomic)) {
      throw new AppError(403, 'AGENT_X402_PAYMENT_LIMIT', 'The caller maximum exceeds this capability’s per-payment x402 ceiling.');
    }
  }
}

export class AgentService {
  readonly store = new AgentStore();
  private readonly automaticExecutions = new Map<string, Promise<AgentRequest>>();
  private readonly x402Submissions = new Map<string, Promise<AgentRequest>>();

  constructor(
    private readonly tokens: TokenService,
    private readonly quotes: QuoteService,
    private readonly stocks: StockService,
    private readonly futures: FuturesService,
    private readonly futuresTransactions: FuturesTransactionService,
    private readonly delegatedSigner: AgentDelegatedSigner = new PrivyAgentDelegatedSigner(),
    private readonly x402: AgentX402Payments = new AgentX402Service(),
  ) {}

  createCredential(userId: string, wallet: string, policy: AgentPolicyInput, delegatedWalletId: string | null = null) {
    if (policy.approvalMode === 'automatic') {
      if (!this.delegatedSigner.available()) {
        throw new AppError(503, 'AGENT_AUTOMATIC_NOT_CONFIGURED', 'Automatic agent execution is not configured on this Flay deployment. Use Always ask for now.');
      }
      if (!delegatedWalletId) {
        throw new AppError(409, 'AGENT_WALLET_NOT_DELEGATED', 'Approve the one-time Privy wallet delegation before creating automatic agent access.');
      }
    }
    return this.store.createCredential(userId, wallet, policy, delegatedWalletId);
  }

  async createCredentialForIdentity(userId: string, wallet: string, policy: AgentPolicyInput) {
    const delegatedWalletId = policy.approvalMode === 'automatic'
      ? await this.delegatedSigner.resolveWalletId(userId, wallet)
      : null;
    return this.createCredential(userId, wallet, policy, delegatedWalletId);
  }

  workspace(userId: string, wallet: string) {
    return this.store.workspace(userId, wallet, this.delegatedSigner.available());
  }

  revoke(userId: string, wallet: string, id: string) {
    return this.store.revoke(userId, wallet, id);
  }

  authorizeCapability(rawCredential: string | undefined) {
    const credential = this.store.authenticate(rawCredential, false);
    return {
      id: credential.id,
      expiresAt: credential.expiresAt,
      products: [...credential.products],
    };
  }

  capability(rawCredential: string | undefined) {
    const credential = this.store.authenticate(rawCredential, false);
    return this.store.summary(credential);
  }

  recentRequests(rawCredential: string | undefined, limit: number) {
    const credential = this.store.authenticate(rawCredential, false);
    return this.store.recentRequests(credential, limit);
  }

  async requestStatus(rawCredential: string | undefined, id: string) {
    const credential = this.store.authenticate(rawCredential, false);
    const request = this.store.capabilityRequest(credential, id);
    const signature = request.execution?.signature;
    if (!signature) {
      return {
        request,
        confirmation: { status: 'not-submitted' as const, checkedAt: Date.now() },
      };
    }
    try {
      const response = await withRpcFallback((rpc) => rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }));
      const current = response.value[0];
      if (!current) {
        return {
          request,
          confirmation: { status: 'not-found' as const, checkedAt: Date.now() },
        };
      }
      return {
        request,
        confirmation: {
          status: current.err
            ? 'failed' as const
            : current.confirmationStatus ?? 'processed' as const,
          slot: current.slot,
          confirmations: current.confirmations,
          error: current.err ?? null,
          checkedAt: Date.now(),
        },
      };
    } catch (error) {
      const appError = asAppError(error, 'SOLANA_STATUS_UNAVAILABLE');
      return {
        request,
        confirmation: {
          status: 'unavailable' as const,
          detail: appError.message,
          checkedAt: Date.now(),
        },
      };
    }
  }

  async submit(rawCredential: string | undefined, submission: AgentIntentSubmission) {
    const credential = this.store.authenticate(rawCredential);
    const policy = this.store.policy(credential);
    assertPolicyBasics(policy, submission.intent);
    const existing = this.store.existingRequest(credential, submission.idempotencyKey, submission.intent);
    if (existing) return policy.approvalMode === 'automatic' ? this.executeAutomatically(credential, existing) : existing;
    if (submission.intent.kind === 'x402') {
      const key = `${credential.id}:${submission.idempotencyKey}`;
      const active = this.x402Submissions.get(key);
      if (active) return active;
      const operation = this.submitX402(credential, policy, submission.idempotencyKey, submission.intent).finally(() => this.x402Submissions.delete(key));
      this.x402Submissions.set(key, operation);
      return operation;
    }
    const risk = await this.riskMicroUsd(credential, policy, submission.intent);
    const maximum = usdToMicro(policy.maxTransactionUsd);
    if (risk > maximum) throw new AppError(403, 'AGENT_TRANSACTION_LIMIT', `This request exceeds the $${policy.maxTransactionUsd} per-request guardrail.`);
    const daily = this.store.dailyRiskMicroUsd(credential.id);
    if (daily + risk > usdToMicro(policy.maxDailyUsd)) throw new AppError(403, 'AGENT_DAILY_LIMIT', `This request would exceed the rolling $${policy.maxDailyUsd} daily guardrail.`);
    const created = this.store.createRequest(credential, submission.idempotencyKey, submission.intent, microToUsd(risk));
    return policy.approvalMode === 'automatic' ? this.executeAutomatically(credential, created) : created;
  }

  async review(userId: string, wallet: string, id: string): Promise<AgentReviewResponse> {
    const request = this.store.ownedRequest(userId, wallet, id);
    const policy = this.store.requestPolicy(request);
    if (policy.approvalMode === 'automatic') {
      throw new AppError(409, 'AGENT_AUTOMATIC_REVIEW_UNAVAILABLE', 'Automatic requests are executed by Flay within their guardrails and do not use manual approval.');
    }
    if (request.status === 'prepared') {
      const existing = this.store.prepared(request);
      if (existing.prepared.expiresAt > Date.now()) {
        return { request: this.store.workspace(userId, wallet).requests.find((item) => item.id === id)!, action: existing };
      }
      this.store.requeueExpiredPreparation(request);
    }
    if (request.status !== 'pending') throw new AppError(409, 'AGENT_REQUEST_STATE_INVALID', 'Only pending requests can be reviewed.');
    try {
      assertPolicyBasics(policy, request.intent);
      const action = await this.prepare(request, policy);
      return { request: this.store.markPrepared(request, action), action };
    } catch (error) {
      const appError = asAppError(error, 'AGENT_PREPARE_FAILED');
      this.store.noteFailure(request, appError.message, !appError.retryable && appError.status < 500);
      throw appError;
    }
  }

  reject(userId: string, wallet: string, id: string) {
    return this.store.reject(this.store.ownedRequest(userId, wallet, id));
  }

  async execute(userId: string, wallet: string, id: string, signedTransaction: string, idempotencyKey: string): Promise<AgentExecutionResponse> {
    const request = this.store.ownedRequest(userId, wallet, id);
    this.store.requestPolicy(request);
    const action = this.store.prepared(request);
    try {
      const result = action.type === 'market'
        ? await this.quotes.execute(action.prepared.preparedId, signedTransaction)
        : action.type === 'futures'
          ? await this.futuresTransactions.execute(action.prepared.preparedId, wallet, signedTransaction, idempotencyKey)
          : await this.x402.execute(action.prepared.preparedId, wallet, signedTransaction);
      const completed = this.store.complete(request, {
        signature: result.signature,
        status: result.status,
        explorerUrl: result.explorerUrl,
        provider: 'provider' in result ? result.provider : result.venue,
        completedAt: Date.now(),
        ...(action.type === 'market' ? {
          marketActivity: {
            kind: action.prepared.review.stock ? 'Stock' as const : 'Market' as const,
            ...('gasPayment' in result && result.gasPayment ? { gasPayment: result.gasPayment } : {}),
            ...(action.prepared.review.stock ? { stock: action.prepared.review.stock } : {}),
          },
        } : {}),
        ...(action.type === 'x402' && 'response' in result ? { x402Response: result.response } : {}),
      });
      return { request: completed, result };
    } catch (error) {
      const appError = asAppError(error, 'AGENT_EXECUTION_FAILED');
      this.store.noteFailure(request, appError.message, false);
      throw appError;
    }
  }

  async completeSponsored(userId: string, wallet: string, id: string, signature: string): Promise<AgentExecutionResponse> {
    const request = this.store.ownedRequest(userId, wallet, id);
    this.store.requestPolicy(request);
    const action = this.store.prepared(request);
    if (action.type !== 'market') throw new AppError(409, 'AGENT_SPONSORED_MISMATCH', 'This is not a sponsored market action.');
    try {
      const result = await this.quotes.completePrivySponsored(action.prepared.preparedId, signature);
      const completed = this.store.complete(request, {
        signature: result.signature,
        status: result.status,
        explorerUrl: result.explorerUrl,
        provider: result.provider,
        completedAt: Date.now(),
        marketActivity: {
          kind: action.prepared.review.stock ? 'Stock' : 'Market',
          ...(result.gasPayment ? { gasPayment: result.gasPayment } : {}),
          ...(action.prepared.review.stock ? { stock: action.prepared.review.stock } : {}),
        },
      });
      return { request: completed, result };
    } catch (error) {
      const appError = asAppError(error, 'AGENT_EXECUTION_FAILED');
      this.store.noteFailure(request, appError.message, false);
      throw appError;
    }
  }

  private executeAutomatically(credential: AgentCredentialRecord, request: AgentRequest): Promise<AgentRequest> {
    if (request.status === 'completed' || request.status === 'failed' || request.status === 'rejected' || request.status === 'expired') {
      return Promise.resolve(request);
    }
    const running = this.automaticExecutions.get(request.id);
    if (running) return running;
    const execution = this.runAutomaticExecution(credential, request.id).finally(() => {
      this.automaticExecutions.delete(request.id);
    });
    this.automaticExecutions.set(request.id, execution);
    return execution;
  }

  private async runAutomaticExecution(credential: AgentCredentialRecord, requestId: string): Promise<AgentRequest> {
    const request = this.store.ownedRequest(credential.userId, credential.wallet, requestId);
    try {
      const delegatedWalletId = this.store.delegatedWalletId(request);
      let action;
      if (request.status === 'prepared') {
        const existing = this.store.prepared(request);
        if (existing.prepared.expiresAt > Date.now()) action = existing;
        else this.store.requeueExpiredPreparation(request);
      }
      if (!action) {
        if (request.status !== 'pending') return this.store.request(request);
        const policy = this.store.requestPolicy(request);
        assertPolicyBasics(policy, request.intent);
        action = await this.prepare(request, policy, delegatedWalletId);
        this.store.markPrepared(request, action, true);
      }

      this.store.requestPolicy(request);
      let result;
      if (
        action.type === 'market'
        && action.prepared.kind === 'market-swap'
        && action.prepared.gasPayment?.provider === 'Privy'
        && (action.prepared.provider === 'raydium' || action.prepared.provider === 'orca')
      ) {
        this.store.prepared(request);
        this.store.requestPolicy(request);
        const signature = await this.delegatedSigner.signAndSendSponsored(
          delegatedWalletId,
          request.wallet,
          action.prepared.transaction,
          `agent-sponsored-${request.id}`,
        );
        result = await this.quotes.completePrivySponsored(action.prepared.preparedId, signature);
      } else {
        const signedTransaction = await this.delegatedSigner.signTransaction(
          delegatedWalletId,
          request.wallet,
          action.prepared.transaction,
          `agent-sign-${request.id}`,
        );
        this.store.prepared(request);
        this.store.requestPolicy(request);
        result = action.type === 'market'
          ? await this.quotes.execute(action.prepared.preparedId, signedTransaction)
          : action.type === 'futures'
            ? await this.futuresTransactions.execute(action.prepared.preparedId, request.wallet, signedTransaction, `agent-execute-${request.id}`)
            : await this.x402.execute(action.prepared.preparedId, request.wallet, signedTransaction);
      }
      return this.store.complete(request, {
        signature: result.signature,
        status: result.status,
        explorerUrl: result.explorerUrl,
        provider: 'provider' in result ? result.provider : result.venue,
        completedAt: Date.now(),
        ...(action.type === 'market' ? {
          marketActivity: {
            kind: action.prepared.review.stock ? 'Stock' as const : 'Market' as const,
            ...('gasPayment' in result && result.gasPayment ? { gasPayment: result.gasPayment } : {}),
            ...(action.prepared.review.stock ? { stock: action.prepared.review.stock } : {}),
          },
        } : {}),
        ...(action.type === 'x402' && 'response' in result ? { x402Response: result.response } : {}),
      });
    } catch (error) {
      const appError = asAppError(error, 'AGENT_AUTOMATIC_EXECUTION_FAILED');
      const terminal = !appError.retryable && appError.status < 500;
      this.store.noteFailure(request, appError.message, terminal);
      return this.store.request(request);
    }
  }

  private async riskMicroUsd(credential: AgentCredentialRecord, policy: AgentPolicyInput, intent: AgentIntent): Promise<bigint> {
    if (intent.kind === 'convert') {
      const token = await this.tokens.getByMint(intent.inputMint);
      if (!token.verified || !token.tradable || token.usdPrice === null) throw new AppError(409, 'AGENT_PRICE_UNAVAILABLE', 'The input token needs a verified live USD price before an agent can request it.', true);
      const atomic = BigInt(intent.amountAtomic);
      const priceMicro = usdToMicro(token.usdPrice);
      return (atomic * priceMicro + (10n ** BigInt(token.decimals) - 1n)) / (10n ** BigInt(token.decimals));
    }
    if (intent.kind === 'stock') {
      const asset = await this.stocks.detail(intent.symbol);
      if (!asset.supportsAtomicSwaps || !asset.token || !asset.multiplier) throw new AppError(409, 'AGENT_STOCK_UNAVAILABLE', 'This xStock is not currently executable.', true);
      if (intent.side === 'buy') return BigInt(decimalToAtomic(intent.amount, 6));
      if (!asset.referencePrice) throw new AppError(409, 'AGENT_PRICE_UNAVAILABLE', 'A live xStock reference price is required for the guardrail check.', true);
      const amount = Number(intent.amount);
      const price = Number(asset.referencePrice);
      if (!Number.isFinite(amount) || !Number.isFinite(price)) throw new AppError(400, 'AGENT_VALUE_INVALID', 'The stock request value is invalid.');
      return usdToMicro(amount * price);
    }
    if (intent.kind === 'futures-open') {
      const portfolio = await this.futures.portfolio(credential.wallet);
      const openPositions = portfolio.venues.phoenix.positions.length + portfolio.venues.gmtrade.positions.length;
      const reservedPositions = this.store.inFlightFuturesOpenCount(credential.wallet);
      if (openPositions + reservedPositions >= policy.maxOpenFuturesPositions) throw new AppError(403, 'AGENT_POSITION_LIMIT', `This wallet already has the allowed ${policy.maxOpenFuturesPositions} open or pending futures positions.`);
      return BigInt(intent.collateralAtomic);
    }
    if (intent.kind === 'x402') return BigInt(intent.maxPaymentAtomic);
    return 0n;
  }

  private async prepare(request: AgentRequestRecord, policy: AgentPolicyInput, delegatedWalletId?: string) {
    const intent = request.intent;
    if (intent.kind === 'convert') {
      const response = await this.quotes.quotes({
        inputMint: intent.inputMint,
        outputMint: intent.outputMint,
        amount: intent.amountAtomic,
        slippageBps: intent.slippageBps,
      });
      const best = response.quotes.find((item) => item.id === response.bestQuoteId);
      const candidates = best
        ? [best, ...response.quotes.filter((item) => item.id !== best.id)]
        : response.quotes;
      if (candidates.length === 0) throw new AppError(409, 'AGENT_NO_ROUTE', 'No executable Convert route is currently available.', true);
      return {
        type: 'market' as const,
        prepared: await prepareRankedMarketRoute(candidates, (quote) => this.quotes.prepare(quote.id, request.wallet)),
      };
    }
    if (intent.kind === 'stock') {
      const response = await this.stocks.quote({ wallet: request.wallet, symbol: intent.symbol, side: intent.side, amount: intent.amount, slippageBps: intent.slippageBps });
      const quote = response.quoteResponse.quotes.find((item) => item.id === response.quoteResponse.bestQuoteId) ?? response.quoteResponse.quotes[0];
      if (!quote) throw new AppError(409, 'AGENT_NO_ROUTE', 'No executable xStocks route is currently available.', true);
      return { type: 'market' as const, prepared: await this.quotes.prepare(quote.id, request.wallet) };
    }
    if (intent.kind === 'futures-open') {
      const portfolio = await this.futures.portfolio(request.wallet);
      const openPositions = portfolio.venues.phoenix.positions.length + portfolio.venues.gmtrade.positions.length;
      const reservedPositions = this.store.inFlightFuturesOpenCount(request.wallet, request.id);
      if (openPositions + reservedPositions >= policy.maxOpenFuturesPositions) throw new AppError(403, 'AGENT_POSITION_LIMIT', `This wallet already has the allowed ${policy.maxOpenFuturesPositions} open or pending futures positions.`);
      const routeIntent: FuturesIntent = {
        wallet: request.wallet,
        market: intent.market,
        side: intent.side,
        orderType: intent.orderType,
        collateralAtomic: intent.collateralAtomic,
        leverageBps: intent.leverageBps,
        limitPriceMicroUsd: intent.limitPriceMicroUsd,
        slippageBps: intent.slippageBps,
        routeChoice: intent.routeChoice,
      };
      const response = await this.futures.routeQuotes(routeIntent);
      const quote = this.selectFuturesQuote(response.quotes, response.recommendedVenue, intent.routeChoice);
      if (!quote?.executionEligible) throw new AppError(409, 'AGENT_NO_ROUTE', quote?.exclusionReason ?? 'No executable Futures route is currently available.', true);
      if (quote.venue === 'phoenix' && delegatedWalletId) {
        await this.ensureAutomaticPhoenixSession(request, delegatedWalletId);
      }
      return {
        type: 'futures' as const,
        prepared: await this.futuresTransactions.prepare({
          wallet: request.wallet,
          action: 'open',
          venue: quote.venue,
          quoteId: quote.id,
          market: quote.market,
          idempotencyKey: request.id,
        }),
      };
    }
    if (intent.kind === 'x402') {
      const prepared = await this.x402.prepare(request.wallet, intent, request.idempotencyKey, policy.maxX402PaymentAtomic);
      if (BigInt(prepared.review.amountAtomic) > BigInt(request.riskUsd)) {
        throw new AppError(409, 'AGENT_X402_PRICE_CHANGED', 'The x402 price increased after the request was created. Submit a new request with a new maximum.');
      }
      return { type: 'x402' as const, prepared };
    }
    const portfolio = await this.futures.portfolio(request.wallet);
    const venue = portfolio.venues[intent.venue];
    const exists = intent.action === 'close'
      ? venue.positions.some((position) => position.nativeId === intent.nativeId && position.market === intent.market)
      : venue.orders.some((order) => order.nativeId === intent.nativeId && order.market === intent.market);
    if (!exists) throw new AppError(409, 'AGENT_FUTURES_TARGET_MISSING', 'The requested Futures position or order is no longer active.', true);
    if (intent.venue === 'phoenix' && delegatedWalletId) {
      await this.ensureAutomaticPhoenixSession(request, delegatedWalletId);
    }
    return {
      type: 'futures' as const,
      prepared: await this.futuresTransactions.prepare({
        wallet: request.wallet,
        action: intent.action,
        venue: intent.venue,
        nativeId: intent.nativeId,
        market: intent.market,
        idempotencyKey: request.id,
      }),
    };
  }

  private async ensureAutomaticPhoenixSession(request: AgentRequestRecord, delegatedWalletId: string): Promise<void> {
    try {
      await this.futuresTransactions.loginPhoenix(request.wallet);
      return;
    } catch (error) {
      const appError = asAppError(error, 'PHOENIX_AUTH_UNAVAILABLE');
      if (appError.code !== 'PHOENIX_WALLET_PROOF_REQUIRED') throw appError;
    }

    const challenge = await this.futuresTransactions.challengePhoenix(request.wallet);
    this.store.requestPolicy(request);
    const signedTransaction = await this.delegatedSigner.signTransaction(
      delegatedWalletId,
      request.wallet,
      challenge.transaction,
      `agent-phoenix-auth-${request.id}-${challenge.challengeId}`,
    );
    this.store.requestPolicy(request);
    await this.futuresTransactions.loginPhoenix(request.wallet, {
      challengeId: challenge.challengeId,
      signedTransaction,
    });
  }

  private selectFuturesQuote(quotes: FuturesRouteQuote[], recommended: 'phoenix' | 'gmtrade' | null, choice: 'auto' | 'phoenix' | 'gmtrade') {
    if (choice !== 'auto') return quotes.find((quote) => quote.venue === choice) ?? null;
    return quotes.find((quote) => quote.venue === recommended) ?? quotes.find((quote) => quote.executionEligible) ?? null;
  }

  private async submitX402(
    credential: AgentCredentialRecord,
    policy: AgentPolicyInput,
    idempotencyKey: string,
    intent: Extract<AgentIntent, { kind: 'x402' }>,
  ): Promise<AgentRequest> {
    const existing = this.store.existingRequest(credential, idempotencyKey, intent);
    if (existing) return policy.approvalMode === 'automatic' ? this.executeAutomatically(credential, existing) : existing;
    const prepared: AgentX402PreparedPayment = await this.x402.prepare(
      credential.wallet,
      intent,
      idempotencyKey,
      policy.maxX402PaymentAtomic,
    );
    const risk = BigInt(prepared.review.amountAtomic);
    if (risk > BigInt(policy.maxX402PaymentAtomic) || risk > BigInt(intent.maxPaymentAtomic)) {
      throw new AppError(403, 'AGENT_X402_PAYMENT_LIMIT', 'The x402 payment exceeds the caller or owner ceiling.');
    }
    if (this.store.dailyX402RiskAtomic(credential.id) + risk > BigInt(policy.maxX402DailyAtomic)) {
      throw new AppError(403, 'AGENT_X402_DAILY_LIMIT', 'This payment would exceed the rolling x402 daily ceiling.');
    }
    if (risk > usdToMicro(policy.maxTransactionUsd)) throw new AppError(403, 'AGENT_TRANSACTION_LIMIT', `This request exceeds the $${policy.maxTransactionUsd} per-request guardrail.`);
    if (this.store.dailyRiskMicroUsd(credential.id) + risk > usdToMicro(policy.maxDailyUsd)) {
      throw new AppError(403, 'AGENT_DAILY_LIMIT', `This request would exceed the rolling $${policy.maxDailyUsd} daily guardrail.`);
    }
    const created = this.store.createRequest(credential, idempotencyKey, intent, risk.toString());
    const record = this.store.ownedRequest(credential.userId, credential.wallet, created.id);
    const request = this.store.markPrepared(record, { type: 'x402', prepared }, policy.approvalMode === 'automatic');
    return policy.approvalMode === 'automatic' ? this.executeAutomatically(credential, request) : request;
  }
}
