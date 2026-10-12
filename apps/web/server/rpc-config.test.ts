import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('Solana RPC transport configuration', () => {
  it('keeps HTTPS requests and WebSocket subscriptions on their configured endpoints', async () => {
    vi.stubEnv('SOLANA_RPC_URL', 'https://rpc.example.test/private-http');
    vi.stubEnv('SOLANA_RPC_WS_URL', 'wss://rpc.example.test/private-ws');

    const [{ config }, { connection }] = await Promise.all([
      import('./config.js'),
      import('./rpc.js'),
    ]);

    expect(connection.rpcEndpoint).toBe(config.rpcUrl);
    expect((connection as unknown as { _rpcWsEndpoint: string })._rpcWsEndpoint).toBe(config.rpcWsUrl);
    expect(config.rpcWsUrl).toBe('wss://rpc.example.test/private-ws');
  });
});
