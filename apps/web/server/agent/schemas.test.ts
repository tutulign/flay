import { describe, expect, it } from 'vitest';
import { SOL_MINT, USDC_MINT } from '../../shared/constants.js';
import { agentIntentSubmissionSchema, agentPolicySchema } from './schemas.js';

const wallet = SOL_MINT;

describe('agent request contracts', () => {
  it('accepts a bounded trading policy', () => {
    const parsed = agentPolicySchema.safeParse({
      wallet,
      name: 'My agent',
      products: ['convert', 'futures'],
      maxTransactionUsd: 25,
      maxDailyUsd: 100,
      maxSlippageBps: 50,
      maxFuturesLeverage: 3,
      maxOpenFuturesPositions: 2,
      allowedTokenMints: [SOL_MINT, USDC_MINT],
      allowedStockSymbols: [],
      allowedFuturesMarkets: ['SOL-PERP'],
      expiresInHours: 24,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.approvalMode).toBe('always-ask');
  });

  it('accepts only the two explicit approval modes and rejects hidden policy fields', () => {
    const valid = {
      wallet,
      name: 'My agent',
      products: ['convert'],
      maxTransactionUsd: 25,
      maxDailyUsd: 100,
      maxSlippageBps: 50,
      maxFuturesLeverage: 3,
      maxOpenFuturesPositions: 2,
      allowedTokenMints: [SOL_MINT, USDC_MINT],
      allowedStockSymbols: [],
      allowedFuturesMarkets: [],
      expiresInHours: 24,
    };
    expect(agentPolicySchema.safeParse({ ...valid, approvalMode: 'automatic' }).success).toBe(true);
    expect(agentPolicySchema.safeParse({ ...valid, approvalMode: 'unrestricted' }).success).toBe(false);
    expect(agentPolicySchema.safeParse({ ...valid, approvalMode: 'automatic', allowFiat: true }).success).toBe(false);
  });

  it('rejects a daily limit below the per-request limit', () => {
    const parsed = agentPolicySchema.safeParse({
      wallet,
      name: 'My agent',
      products: ['stocks'],
      maxTransactionUsd: 50,
      maxDailyUsd: 25,
      maxSlippageBps: 50,
      maxFuturesLeverage: 3,
      maxOpenFuturesPositions: 2,
      allowedTokenMints: [],
      allowedStockSymbols: ['AAPLX'],
      allowedFuturesMarkets: [],
      expiresInHours: 24,
    });
    expect(parsed.success).toBe(false);
  });

  it('has no fiat, wallet-send, key-export, or arbitrary-call intent', () => {
    for (const kind of ['fiat-onramp', 'send', 'export-key', 'program-call']) {
      const parsed = agentIntentSubmissionSchema.safeParse({ idempotencyKey: crypto.randomUUID(), intent: { kind, amount: '10', program: SOL_MINT } });
      expect(parsed.success, kind).toBe(false);
    }
  });

  it('rejects hidden extra fields on an otherwise valid intent', () => {
    const parsed = agentIntentSubmissionSchema.safeParse({
      idempotencyKey: crypto.randomUUID(),
      intent: {
        kind: 'convert', inputMint: USDC_MINT, outputMint: SOL_MINT, amountAtomic: '1000000', slippageBps: 50,
        destination: 'attacker',
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('normalizes a bounded x402 policy while preserving safe defaults for older policies', () => {
    const base = {
      wallet,
      name: 'API agent',
      products: ['convert'],
      maxTransactionUsd: 25,
      maxDailyUsd: 100,
      maxSlippageBps: 50,
      maxFuturesLeverage: 3,
      maxOpenFuturesPositions: 2,
      allowedTokenMints: [SOL_MINT, USDC_MINT],
      allowedStockSymbols: [],
      allowedFuturesMarkets: [],
      expiresInHours: 24,
    };
    const legacy = agentPolicySchema.parse(base);
    expect(legacy).toMatchObject({ x402AllowedOrigins: [], x402AllowedMethods: ['GET'], maxX402PaymentAtomic: '10000', maxX402DailyAtomic: '1000000' });

    const paid = agentPolicySchema.parse({
      ...base,
      products: ['x402'],
      allowedTokenMints: [],
      x402AllowedOrigins: ['https://PAID.example/', 'https://paid.example'],
      x402AllowedMethods: ['GET', 'POST'],
      maxX402PaymentAtomic: '1',
      maxX402DailyAtomic: '2',
    });
    expect(paid.x402AllowedOrigins).toEqual(['https://paid.example']);
    expect(paid.maxX402PaymentAtomic).toBe('1');
  });

  it('rejects x402 without an origin, unsafe URLs, GET bodies, and oversized POST bodies', () => {
    const base = {
      wallet,
      name: 'API agent',
      products: ['x402'],
      maxTransactionUsd: 25,
      maxDailyUsd: 100,
      maxSlippageBps: 50,
      maxFuturesLeverage: 3,
      maxOpenFuturesPositions: 2,
      allowedTokenMints: [],
      allowedStockSymbols: [],
      allowedFuturesMarkets: [],
      expiresInHours: 24,
    };
    expect(agentPolicySchema.safeParse(base).success).toBe(false);
    expect(agentPolicySchema.safeParse({ ...base, x402AllowedOrigins: ['http://paid.example'] }).success).toBe(false);
    expect(agentIntentSubmissionSchema.safeParse({
      idempotencyKey: crypto.randomUUID(),
      intent: { kind: 'x402', url: 'https://paid.example/report', method: 'GET', body: { query: 'SOL' }, maxPaymentAtomic: '1' },
    }).success).toBe(false);
    expect(agentIntentSubmissionSchema.safeParse({
      idempotencyKey: crypto.randomUUID(),
      intent: { kind: 'x402', url: 'https://paid.example/report', method: 'POST', body: { query: 'x'.repeat(8 * 1024) }, maxPaymentAtomic: '1' },
    }).success).toBe(false);
    expect(agentIntentSubmissionSchema.safeParse({
      idempotencyKey: crypto.randomUUID(),
      intent: { kind: 'x402', url: 'https://user:secret@paid.example/report', method: 'POST', maxPaymentAtomic: '1' },
    }).success).toBe(false);
  });
});
