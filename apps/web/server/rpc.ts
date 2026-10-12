import { Connection } from '@solana/web3.js';
import { config } from './config.js';
import { AppError } from './errors.js';
import { createRateLimitedFetch, RpcRequestLimiter } from './rpc-rate-limiter.js';

function limitedFetch() {
  return createRateLimitedFetch(new RpcRequestLimiter({
    maxRequestsPerSecond: config.rpcMaxRequestsPerSecond,
    maxConcurrency: config.rpcMaxConcurrency,
    queueTimeoutMs: config.rpcQueueTimeoutMs,
  }));
}

export const connection = new Connection(config.rpcUrl, {
  commitment: config.commitment,
  confirmTransactionInitialTimeout: 45_000,
  disableRetryOnRateLimit: true,
  fetch: limitedFetch(),
  wsEndpoint: config.rpcWsUrl,
});

export const fallbackConnection = config.fallbackRpcUrl
  ? new Connection(config.fallbackRpcUrl, {
      commitment: config.commitment,
      confirmTransactionInitialTimeout: 45_000,
      disableRetryOnRateLimit: true,
      fetch: limitedFetch(),
    })
  : null;

export async function withRpcFallback<T>(operation: (rpc: Connection) => Promise<T>): Promise<T> {
  try {
    return await operation(connection);
  } catch (primaryError) {
    if (!fallbackConnection) {
      throw new AppError(
        503,
        'RPC_UNAVAILABLE',
        primaryError instanceof Error ? `Solana RPC: ${primaryError.message}` : 'Solana RPC is unavailable.',
        true,
      );
    }
    try {
      return await operation(fallbackConnection);
    } catch {
      throw new AppError(503, 'RPC_UNAVAILABLE', 'Both configured Solana RPC endpoints are unavailable.', true);
    }
  }
}
