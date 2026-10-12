import { decimalToAtomic } from '../../shared/amounts';

export interface X402PolicyFields {
  enabled: boolean;
  origins: string[];
  methods: Array<'GET' | 'POST'>;
  perPaymentUsd: string;
  dailyUsd: string;
}

function isHttpsOrigin(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && !parsed.username
      && !parsed.password
      && !parsed.port
      && !parsed.search
      && !parsed.hash
      && parsed.pathname === '/';
  } catch {
    return false;
  }
}

export function validateX402PolicyFields(fields: X402PolicyFields): string | null {
  if (!fields.enabled) return null;
  if (fields.origins.length === 0) {
    return 'Enter at least one allowed x402 HTTPS origin, for example https://x402engine.app.';
  }
  if (fields.origins.some((origin) => !isHttpsOrigin(origin))) {
    return 'Use an HTTPS origin only, without a path, query, credentials, fragment, or custom port.';
  }
  if (fields.methods.length === 0) return 'Keep at least one x402 method enabled.';

  let perPayment: bigint;
  let daily: bigint;
  try {
    perPayment = BigInt(decimalToAtomic(fields.perPaymentUsd, 6));
    daily = BigInt(decimalToAtomic(fields.dailyUsd, 6));
  } catch (error) {
    return error instanceof Error ? error.message : 'Enter valid x402 payment limits.';
  }
  if (perPayment <= 0n) return 'The x402 per-payment limit must be at least $0.000001.';
  if (daily <= 0n) return 'The x402 rolling 24-hour limit must be at least $0.000001.';
  if (daily < perPayment) return 'The x402 rolling 24-hour limit must be at least the per-payment limit.';
  return null;
}
