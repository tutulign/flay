import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOL_MINT, USDC_MINT } from '../shared/constants.js';
import { createApiRouter } from './api.js';
import { config } from './config.js';
import { FuturesService } from './futures/futures-service.js';
import { MagicBlockService } from './magicblock-service.js';
import { StockService } from './stocks-service.js';

function testApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use('/api', createApiRouter());
  return app;
}

describe('Flay API boundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reports mainnet providers and hardened response headers', async () => {
    vi.spyOn(FuturesService.prototype, 'diagnostics').mockResolvedValue({
      checkedAt: Date.now(),
      phoenixPublic: { publicData: true, execution: false, status: 'onboarding-required', detail: 'Wallet onboarding required.', checkedAt: Date.now() },
      gmtrade: { publicData: true, execution: true, status: 'ready', detail: 'Adapter ready.', checkedAt: Date.now() },
      candles: { available: true, fresh: true, latestCandleAt: Date.now(), detail: 'Phoenix external reference' },
      rpc: { available: true, detail: 'Latest blockhash is available.' },
      simulation: { available: true, detail: 'Simulation endpoint is available.' },
      gmtradeProcess: { requests: 1, failures: 0, lastLatencyMs: 1, lastFailureAt: null, running: true, binary: true },
      phoenixStream: { updates: 0, reconnects: 0, sequenceRepairs: 0, lastUpdateAt: null, lastErrorAt: null, provider: { requests: 1, failures: 0, staleResults: 0, lastLatencyMs: 1, lastFailureAt: null }, health: 'live', source: 'http' },
    } as unknown as Awaited<ReturnType<FuturesService['diagnostics']>>);
    const magicStatus = vi.spyOn(MagicBlockService.prototype, 'status').mockResolvedValue({
      available: true,
      cluster: 'mainnet',
      token: { mint: USDC_MINT, symbol: 'USDC', decimals: 6 },
      mintInitialized: true,
      privateTransfers: true,
      teeAttested: true,
      authorizationMode: 'verified',
      detail: 'MagicBlock mainnet TEE attestation and wallet authorization are verified.',
      checkedAt: Date.now(),
      provider: 'MagicBlock Ephemeral SPL Token',
    });
    vi.spyOn(StockService.prototype, 'diagnostics').mockResolvedValue({
      available: true,
      assetCount: 100,
      status: 'ready',
      checkedAt: Date.now(),
      detail: '100 official Solana xStocks deployments loaded.',
    });
    const response = await request(testApp()).get('/api/health').expect(200);
    expect(response.body.network).toBe('solana-mainnet-beta');
    expect(response.body.readiness.jupiterTrigger).toBe(true);
    expect(response.body.readiness.magicBlock).toBe(true);
    expect(response.body.magicBlockReadiness.authorizationMode).toBe('verified');
    expect(response.body.providers.magicBlock).toBe('MagicBlock Ephemeral SPL Token');
    expect(response.body.providers.fiatOnRamp).toBe('Privy Card Onramps');
    expect(response.body.providers.stocks).toEqual(['xStocks', 'Jupiter Swap V2 Router']);
    expect(response.body.providers.agentPayments).toBe('x402 v2 exact · Solana mainnet USDC payer');
    expect(response.body.readiness.xstocks).toBe(true);
    expect(response.body.readiness.x402Payer).toBe(true);
    expect(response.body.gasless).toEqual({
      scope: 'eligible-market-swaps-and-usdc-send',
      providers: ['Jupiter', 'Privy'],
      integratorSponsor: false,
      privyManagedSponsor: true,
      detail: 'Jupiter sponsors eligible Jupiter orders. Privy sponsors eligible reviewed Raydium/Orca SPL swaps and the reviewed USDC send flow.',
    });
    expect(response.body.alchemyPay).toMatchObject({ provider: 'Alchemy Pay', asset: 'USDC', network: 'SOL' });
    expect(response.body.privyFiatOnramp).toEqual({
      provider: 'Privy',
      environment: config.privyFiatOnrampEnvironment,
      asset: 'USDC',
      network: 'SOL',
      supportedFiat: ['USD', 'EUR', 'AUD', 'BRL'],
      dashboardActivation: 'required',
    });
    expect(response.body.providers.market).toEqual([
      'Jupiter Swap V2',
      'Raydium Trade API',
      'Orca Whirlpools SDK',
    ]);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-powered-by']).toBeUndefined();

    magicStatus.mockResolvedValue({
      available: false,
      cluster: 'mainnet',
      token: { mint: USDC_MINT, symbol: 'USDC', decimals: 6 },
      mintInitialized: true,
      privateTransfers: false,
      teeAttested: true,
      authorizationMode: 'mock',
      detail: 'MagicBlock mainnet is returning mock authorization.',
      checkedAt: Date.now(),
      provider: 'MagicBlock Ephemeral SPL Token',
    });
    const paused = await request(testApp()).get('/api/health').expect(200);
    expect(paused.body.readiness.magicBlock).toBe(false);
    expect(paused.body.magicBlockReadiness.authorizationMode).toBe('mock');
  });

  it('publishes safe Alchemy Pay capability while protecting wallet-bound orders', async () => {
    const capability = await request(testApp()).get('/api/fiat/capability').expect(200);
    expect(capability.body).toMatchObject({ provider: 'Alchemy Pay', asset: 'USDC', network: 'SOL' });
    expect(JSON.stringify(capability.body)).not.toMatch(/secret/i);

    const wallet = SOL_MINT;
    const orders = await request(testApp()).get(`/api/fiat/orders?wallet=${wallet}`);
    expect([401, 503]).toContain(orders.status);
    const checkout = await request(testApp()).post('/api/fiat/checkout').send({ wallet, fiat: 'USD', fiatAmount: '50.00' });
    expect([401, 503]).toContain(checkout.status);
  });

  it('rejects invalid quote inputs before contacting providers', async () => {
    const invalidMint = await request(testApp())
      .get(`/api/quotes?inputMint=not-a-mint&outputMint=${USDC_MINT}&amount=1000&slippageBps=50`)
      .expect(400);
    expect(invalidMint.body.error.code).toBe('INVALID_REQUEST');

    const sameMint = await request(testApp())
      .get(`/api/quotes?inputMint=${SOL_MINT}&outputMint=${SOL_MINT}&amount=1000&slippageBps=50`)
      .expect(400);
    expect(sameMint.body.error.details.fieldErrors.outputMint).toContain('Choose two different tokens.');
  });

  it('protects stock quotes behind wallet authentication and validates stock symbols', async () => {
    const protectedResponse = await request(testApp()).post('/api/stocks/quotes').send({
      wallet: SOL_MINT,
      symbol: 'AAPLx',
      side: 'buy',
      amount: '10',
      slippageBps: 50,
    });
    expect([401, 503]).toContain(protectedResponse.status);
    const invalid = await request(testApp()).get('/api/stocks/not%20valid').expect(400);
    expect(invalid.body.error.code).toBe('INVALID_REQUEST');
  });

  it('rejects cross-origin mutations before any wallet operation', async () => {
    const response = await request(testApp())
      .post('/api/market/prepare')
      .set('Origin', 'https://malicious.example')
      .set('Host', 'flay.local')
      .send({ quoteId: '00000000-0000-4000-8000-000000000000', wallet: SOL_MINT })
      .expect(403);
    expect(response.body.error.code).toBe('ORIGIN_REJECTED');
  });

  it('returns actionable malformed and oversized JSON errors', async () => {
    const malformed = await request(testApp())
      .post('/api/market/prepare')
      .set('Content-Type', 'application/json')
      .send('{"wallet":')
      .expect(400);
    expect(malformed.body.error.code).toBe('INVALID_JSON');

    const oversized = await request(testApp())
      .post('/api/market/prepare')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ value: 'x'.repeat(25 * 1024) }))
      .expect(413);
    expect(oversized.body.error.code).toBe('REQUEST_TOO_LARGE');
  });

  it('protects wallet balances and returns structured 404 errors', async () => {
    const protectedResponse = await request(testApp())
      .get(`/api/balances?wallet=${SOL_MINT}`);
    expect([401, 503]).toContain(protectedResponse.status);
    expect(['AUTH_REQUIRED', 'AUTH_NOT_CONFIGURED']).toContain(protectedResponse.body.error.code);

    const missing = await request(testApp()).get('/api/does-not-exist').expect(404);
    expect(missing.body.error).toMatchObject({ code: 'NOT_FOUND', retryable: false });
  });

  it('protects sponsored completion behind wallet authentication', async () => {
    const response = await request(testApp())
      .post('/api/transactions/sponsored/complete')
      .send({
        preparedId: '00000000-0000-4000-8000-000000000000',
        signature: '1'.repeat(88),
      });
    expect([401, 503]).toContain(response.status);
    expect(['AUTH_REQUIRED', 'AUTH_NOT_CONFIGURED']).toContain(response.body.error.code);
  });
});
