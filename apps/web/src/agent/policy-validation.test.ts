import { describe, expect, it } from 'vitest';
import { validateX402PolicyFields } from './policy-validation';

const valid = {
  enabled: true,
  origins: ['https://x402engine.app'],
  methods: ['GET'] as Array<'GET' | 'POST'>,
  perPaymentUsd: '0.001',
  dailyUsd: '0.005',
};

describe('x402 credential policy validation', () => {
  it('requires an origin when x402 is enabled', () => {
    expect(validateX402PolicyFields({ ...valid, origins: [] })).toContain('at least one allowed x402 HTTPS origin');
  });

  it('requires an origin rather than a complete resource path', () => {
    expect(validateX402PolicyFields({ ...valid, origins: ['https://x402engine.app/api/crypto/trending'] })).toContain('without a path');
  });

  it('requires a method and consistent positive limits', () => {
    expect(validateX402PolicyFields({ ...valid, methods: [] })).toContain('at least one x402 method');
    expect(validateX402PolicyFields({ ...valid, perPaymentUsd: '0' })).toContain('at least $0.000001');
    expect(validateX402PolicyFields({ ...valid, dailyUsd: '0.0005' })).toContain('at least the per-payment limit');
  });

  it('accepts the verified test policy and ignores x402 fields when disabled', () => {
    expect(validateX402PolicyFields(valid)).toBeNull();
    expect(validateX402PolicyFields({ ...valid, enabled: false, origins: [] })).toBeNull();
  });
});
