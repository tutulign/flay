import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { JUP_MINT, SOL_MINT, USDC_MINT } from '../../shared/constants.js';
import type { AgentRequest } from '../../shared/agent.js';
import type { TokenInfo } from '../../shared/types.js';
import { agentRequestResult, selectAgentTokens } from './mcp.js';

vi.mock('@privy-io/node', () => ({
  verifyIdentityToken: vi.fn().mockResolvedValue({
    id: 'did:privy:mcp-test',
    linked_accounts: [{
      type: 'wallet', chain_type: 'solana', wallet_client_type: 'privy-v2', connector_type: 'embedded', user_can_sign: true, address: SOL_MINT,
    }],
  }),
}));

const identity = { 'x-privy-identity-token': 'valid-mcp-test-token' };
const futuresPolicy = {
  wallet: SOL_MINT,
  name: 'MCP futures',
  products: ['futures'],
  maxTransactionUsd: 25,
  maxDailyUsd: 100,
  maxSlippageBps: 50,
  maxFuturesLeverage: 3,
  maxOpenFuturesPositions: 2,
  allowedTokenMints: [SOL_MINT, USDC_MINT],
  allowedStockSymbols: [],
  allowedFuturesMarkets: ['SOL-PERP'],
  expiresInHours: 24,
};
const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'flay-test', version: '1.0.0' } },
};
const expectedTools = [
  'flay_get_capability',
  'flay_get_futures_markets',
  'flay_get_request_status',
  'flay_get_stocks',
  'flay_get_tokens',
  'flay_list_requests',
  'flay_request_convert',
  'flay_request_futures_manage',
  'flay_request_futures_open',
  'flay_request_stock_trade',
];

let app: express.Express;
let server: ReturnType<express.Express['listen']>;
let endpoint: URL;

beforeAll(async () => {
  const configModule = await import('../config.js');
  configModule.config.privyAppId = 'test-app';
  configModule.config.privyVerificationKey = 'test-key';
  const { createApiRouter } = await import('../api.js');
  app = express();
  app.use('/api', createApiRouter());
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  endpoint = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp`);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function createCapability(policy = futuresPolicy) {
  const response = await request(app).post('/api/agent/credentials').set(identity).send(policy).expect(201);
  return { credential: response.body.credential as string, id: response.body.summary.id as string };
}

async function connect(credential: string) {
  const client = new Client({ name: 'flay-integration-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    authProvider: { token: async () => credential },
  });
  await client.connect(transport);
  return client;
}

describe('Flay Streamable HTTP MCP', () => {
  it('excludes unverified or blocked token lookalikes and ranks canonical USDC first', () => {
    const token = (input: Partial<TokenInfo> & Pick<TokenInfo, 'mint' | 'symbol'>): TokenInfo => ({
      name: input.symbol, decimals: 6, logoUri: null, tokenProgram: 'spl-token', verified: true,
      tags: [], extensions: [], tradable: true, blockedReason: null, usdPrice: 1, ...input,
    });
    const selected = selectAgentTokens([
      token({ mint: JUP_MINT, symbol: 'USDC' }),
      token({ mint: SOL_MINT, symbol: 'USDC', verified: false }),
      token({ mint: USDC_MINT, symbol: 'USDC' }),
      token({ mint: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp', symbol: 'USDC', tradable: false, blockedReason: 'blocked' }),
    ], 'USDC');
    expect(selected.map((item) => item.mint)).toEqual([USDC_MINT, JUP_MINT]);
  });

  it('reports the owner-selected approval mode and actual automatic execution outcome', () => {
    const result = agentRequestResult({
      id: 'request-id', credentialId: 'credential-id', credentialName: 'Auto', wallet: SOL_MINT,
      approvalMode: 'automatic', intent: { kind: 'convert', inputMint: USDC_MINT, outputMint: SOL_MINT, amountAtomic: '1000000', slippageBps: 50 },
      riskUsd: '1000000', status: 'completed', createdAt: 1, expiresAt: 2, reviewedAt: 1, rejectedAt: null, failure: null,
      execution: { signature: 'signature', status: 'confirmed', explorerUrl: 'https://explorer.invalid', provider: 'Jupiter', completedAt: 2 },
    } satisfies AgentRequest);
    expect(result.structuredContent).toMatchObject({ fundsMoved: true, humanApprovalRequired: false, request: { approvalMode: 'automatic', status: 'completed' } });
  });

  it('never claims funds moved when automatic execution is pending or failed', () => {
    for (const status of ['pending', 'failed'] as const) {
      const result = agentRequestResult({
        id: `request-${status}`, credentialId: 'credential-id', credentialName: 'Auto', wallet: SOL_MINT,
        approvalMode: 'automatic', intent: { kind: 'convert', inputMint: USDC_MINT, outputMint: SOL_MINT, amountAtomic: '1000000', slippageBps: 50 },
        riskUsd: '1000000', status, createdAt: 1, expiresAt: 2, reviewedAt: status === 'failed' ? 1 : null,
        rejectedAt: null, failure: 'Provider unavailable.', execution: null,
      } satisfies AgentRequest);
      expect(result.structuredContent).toMatchObject({ fundsMoved: false, humanApprovalRequired: false, request: { status, execution: null } });
    }
  });

  it('initializes with the official client, lists only narrow tools, and queues a human-approved proposal', async () => {
    const { credential } = await createCapability();
    const client = await connect(credential);
    try {
      const catalog = await client.listTools();
      expect(catalog.tools.map((tool) => tool.name).sort()).toEqual(expectedTools);
      expect(JSON.stringify(catalog)).not.toContain(credential);
      expect(catalog.tools.every((tool) => !/(fiat|send|transfer|sign|export|key|transaction)/i.test(tool.name))).toBe(true);

      const capability = await client.callTool({ name: 'flay_get_capability', arguments: {} });
      expect(capability.structuredContent).toMatchObject({
        ok: true,
        capability: { approvalMode: 'always-ask', wallet: SOL_MINT, products: ['futures'] },
      });

      const tokenResult = await client.callTool({ name: 'flay_get_tokens', arguments: { query: USDC_MINT } });
      expect(tokenResult.isError).not.toBe(true);
      expect(tokenResult.structuredContent).toMatchObject({
        ok: true,
        count: 1,
        tokens: [{ mint: USDC_MINT, symbol: 'USDC', decimals: 6, verified: true }],
      });

      const result = await client.callTool({
        name: 'flay_request_futures_manage',
        arguments: {
          idempotencyKey: crypto.randomUUID(),
          action: 'cancel',
          venue: 'phoenix',
          market: 'SOL-PERP',
          nativeId: 'provider-order-mcp-1',
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ ok: true, fundsMoved: false, humanApprovalRequired: true, request: { status: 'pending', kind: 'futures-manage' } });
      expect(JSON.stringify(result)).not.toContain(credential);
      const requestId = (result.structuredContent as { request: { id: string } }).request.id;

      const status = await client.callTool({ name: 'flay_get_request_status', arguments: { requestId } });
      expect(status.structuredContent).toMatchObject({
        ok: true,
        request: { id: requestId, status: 'pending', execution: null },
        confirmation: { status: 'not-submitted' },
        humanApprovalRequired: true,
      });
      const recent = await client.callTool({ name: 'flay_list_requests', arguments: { limit: 5 } });
      expect(recent.structuredContent).toMatchObject({ ok: true, count: 1, requests: [{ id: requestId, status: 'pending' }] });

      const workspace = await request(app).get(`/api/agent/workspace?wallet=${SOL_MINT}`).set(identity).expect(200);
      expect(workspace.body.requests.some((item: { intent: { kind: string } }) => item.intent.kind === 'futures-manage')).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('keeps concurrent capability policies isolated', async () => {
    const futures = await createCapability();
    const convert = await createCapability({
      ...futuresPolicy,
      name: 'MCP convert',
      products: ['convert'],
      allowedFuturesMarkets: [],
    });
    const [futuresClient, convertClient] = await Promise.all([connect(futures.credential), connect(convert.credential)]);
    const toolCall = () => ({
      name: 'flay_request_futures_manage',
      arguments: { idempotencyKey: crypto.randomUUID(), action: 'cancel', venue: 'phoenix', market: 'SOL-PERP', nativeId: 'isolation-order' },
    });
    try {
      const [allowed, denied] = await Promise.all([futuresClient.callTool(toolCall()), convertClient.callTool(toolCall())]);
      expect(allowed.isError).not.toBe(true);
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent).toMatchObject({ ok: false, error: { code: 'AGENT_PRODUCT_DENIED' } });
      const allowedId = (allowed.structuredContent as { request: { id: string } }).request.id;
      const hidden = await convertClient.callTool({ name: 'flay_get_request_status', arguments: { requestId: allowedId } });
      expect(hidden.isError).toBe(true);
      expect(hidden.structuredContent).toMatchObject({ ok: false, error: { code: 'AGENT_REQUEST_NOT_FOUND' } });
    } finally {
      await Promise.all([futuresClient.close(), convertClient.close()]);
    }
  });

  it('rejects missing, malformed, revoked, cross-origin, unsupported, and oversized requests', async () => {
    const missing = await request(app).post('/api/mcp').send(initialize).expect(401);
    expect(missing.body.error.data.code).toBe('AGENT_CREDENTIAL_REQUIRED');
    expect(missing.headers['www-authenticate']).toContain('Flay MCP');

    const malformed = await request(app).post('/api/mcp').set('Authorization', 'Bearer wrong').send(initialize).expect(401);
    expect(malformed.body.error.data.code).toBe('AGENT_CREDENTIAL_INVALID');

    const active = await createCapability();
    await request(app).post(`/api/agent/credentials/${active.id}/revoke`).set(identity).send({ wallet: SOL_MINT }).expect(200);
    const revoked = await request(app).post('/api/mcp').set('Authorization', `Bearer ${active.credential}`).send(initialize).expect(401);
    expect(revoked.body.error.data.code).toBe('AGENT_CREDENTIAL_REVOKED');

    const expiring = await createCapability({ ...futuresPolicy, name: 'Expiring MCP capability', expiresInHours: 1 });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 60 * 60_000);
    const expired = await request(app).post('/api/mcp').set('Authorization', `Bearer ${expiring.credential}`).send(initialize).expect(401);
    clock.mockRestore();
    expect(expired.body.error.data.code).toBe('AGENT_CREDENTIAL_EXPIRED');

    const valid = expiring;
    const foreignOrigin = await request(app).post('/api/mcp')
      .set('Authorization', `Bearer ${valid.credential}`)
      .set('Origin', 'https://evil.example')
      .send(initialize).expect(403);
    expect(foreignOrigin.body.error.data.code).toBe('ORIGIN_REJECTED');

    const method = await request(app).patch('/api/mcp').set('Authorization', `Bearer ${valid.credential}`).send({}).expect(405);
    expect(method.headers.allow).toBe('POST, GET, DELETE');
    expect(method.body.error.data.code).toBe('MCP_METHOD_NOT_ALLOWED');

    const standaloneStream = await request(app).get('/api/mcp').set('Authorization', `Bearer ${valid.credential}`);
    expect([400, 405]).toContain(standaloneStream.status);
    expect(JSON.stringify(standaloneStream.body)).not.toContain(valid.credential);

    const sessionDelete = await request(app).delete('/api/mcp').set('Authorization', `Bearer ${valid.credential}`);
    expect([400, 405]).toContain(sessionDelete.status);
    expect(JSON.stringify(sessionDelete.body)).not.toContain(valid.credential);

    const oversized = await request(app).post('/api/mcp')
      .set('Authorization', `Bearer ${valid.credential}`)
      .set('Content-Type', 'application/json')
      .send({ ...initialize, padding: 'x'.repeat(50 * 1024) });
    expect(oversized.status).toBe(413);
    expect(JSON.stringify(oversized.body)).not.toContain(valid.credential);
  });
});
