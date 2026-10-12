import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  AgentAuditEvent,
  AgentCredentialCreated,
  AgentCredentialSummary,
  AgentExecutionSummary,
  AgentIntent,
  AgentPolicyInput,
  AgentPreparedAction,
  AgentRequest,
} from '../../shared/agent.js';
import { AppError } from '../errors.js';

const REQUEST_TTL_MS = 15 * 60_000;
const MAX_CREDENTIALS = 2_000;
const MAX_REQUESTS = 5_000;
const MAX_AUDIT_EVENTS = 10_000;
const CREDENTIAL_PATTERN = /^flay_agent_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;

interface CredentialRecord extends AgentCredentialSummary {
  userId: string;
  tokenHash: Buffer;
  policy: AgentPolicyInput;
  delegatedWalletId: string | null;
}

interface RequestRecord extends AgentRequest {
  userId: string;
  idempotencyKey: string;
  fingerprint: string;
  prepared: AgentPreparedAction | null;
}

interface CredentialRateBucket { resetAt: number; count: number }

function hashCredential(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function intentFingerprint(intent: AgentIntent): string {
  return createHash('sha256').update(JSON.stringify(intent)).digest('hex');
}

function status(record: CredentialRecord, now = Date.now()): AgentCredentialSummary['status'] {
  if (record.revokedAt) return 'revoked';
  if (record.expiresAt <= now) return 'expired';
  return 'active';
}

function publicCredential(record: CredentialRecord): AgentCredentialSummary {
  const { userId: _userId, tokenHash: _tokenHash, policy: _policy, delegatedWalletId: _delegatedWalletId, ...summary } = record;
  return { ...summary, status: status(record) };
}

function publicRequest(record: RequestRecord): AgentRequest {
  if ((record.status === 'pending' || record.status === 'prepared') && record.expiresAt <= Date.now()) {
    record.status = 'expired';
    record.prepared = null;
  }
  const { userId: _userId, idempotencyKey: _idempotencyKey, fingerprint: _fingerprint, prepared: _prepared, ...request } = record;
  const safeIntent: AgentIntent = request.intent.kind === 'x402'
    ? {
        kind: 'x402',
        url: request.intent.url,
        method: request.intent.method,
        maxPaymentAtomic: request.intent.maxPaymentAtomic,
      }
    : structuredClone(request.intent);
  return structuredClone({ ...request, intent: safeIntent });
}

export class AgentStore {
  private credentials = new Map<string, CredentialRecord>();
  private requests = new Map<string, RequestRecord>();
  private auditEvents: AgentAuditEvent[] = [];
  private rateBuckets = new Map<string, CredentialRateBucket>();

  createCredential(userId: string, wallet: string, policy: AgentPolicyInput, delegatedWalletId: string | null = null): AgentCredentialCreated {
    this.sweep();
    if (this.credentials.size >= MAX_CREDENTIALS) throw new AppError(503, 'AGENT_CAPACITY_REACHED', 'Agent access is temporarily at capacity.', true);
    const id = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const credential = `flay_agent_${id}.${secret}`;
    const now = Date.now();
    const record: CredentialRecord = {
      id,
      name: policy.name,
      wallet,
      approvalMode: policy.approvalMode,
      userId,
      tokenHash: hashCredential(credential),
      policy: structuredClone(policy),
      delegatedWalletId,
      status: 'active',
      products: [...policy.products],
      maxTransactionUsd: policy.maxTransactionUsd,
      maxDailyUsd: policy.maxDailyUsd,
      maxSlippageBps: policy.maxSlippageBps,
      maxFuturesLeverage: policy.maxFuturesLeverage,
      maxOpenFuturesPositions: policy.maxOpenFuturesPositions,
      allowedTokenMints: [...policy.allowedTokenMints],
      allowedStockSymbols: [...policy.allowedStockSymbols],
      allowedFuturesMarkets: [...policy.allowedFuturesMarkets],
      x402AllowedOrigins: [...policy.x402AllowedOrigins],
      x402AllowedMethods: [...policy.x402AllowedMethods],
      maxX402PaymentAtomic: policy.maxX402PaymentAtomic,
      maxX402DailyAtomic: policy.maxX402DailyAtomic,
      createdAt: now,
      expiresAt: now + policy.expiresInHours * 60 * 60_000,
      revokedAt: null,
    };
    this.credentials.set(id, record);
    this.audit(wallet, id, null, 'credential-created', `Created ${policy.name} in ${policy.approvalMode} mode with ${policy.expiresInHours}h expiry.`);
    return {
      credential,
      summary: publicCredential(record),
      warning: 'Copy this credential now. Flay stores only its SHA-256 hash and cannot show it again.',
    };
  }

  authenticate(raw: string | undefined, consumeRateLimit = true): CredentialRecord {
    if (!raw || raw.length > 256) throw new AppError(401, 'AGENT_CREDENTIAL_REQUIRED', 'Provide an agent capability credential.');
    const match = raw.match(CREDENTIAL_PATTERN);
    if (!match) throw new AppError(401, 'AGENT_CREDENTIAL_INVALID', 'The agent capability credential is invalid.');
    const record = this.credentials.get(match[1]);
    const received = hashCredential(raw);
    if (!record || received.length !== record.tokenHash.length || !timingSafeEqual(received, record.tokenHash)) {
      throw new AppError(401, 'AGENT_CREDENTIAL_INVALID', 'The agent capability credential is invalid.');
    }
    const currentStatus = status(record);
    if (currentStatus === 'revoked') throw new AppError(401, 'AGENT_CREDENTIAL_REVOKED', 'This agent capability was revoked.');
    if (currentStatus === 'expired') throw new AppError(401, 'AGENT_CREDENTIAL_EXPIRED', 'This agent capability expired.');
    if (consumeRateLimit) this.consumeRateLimit(record.id);
    return record;
  }

  revoke(userId: string, wallet: string, id: string): AgentCredentialSummary {
    const record = this.ownedCredential(userId, wallet, id);
    if (!record.revokedAt) {
      record.revokedAt = Date.now();
      record.status = 'revoked';
      this.audit(wallet, id, null, 'credential-revoked', `Revoked ${record.name}.`);
    }
    return publicCredential(record);
  }

  workspace(userId: string, wallet: string, automaticExecutionConfigured = false) {
    this.sweep();
    return {
      credentials: [...this.credentials.values()].filter((record) => record.userId === userId && record.wallet === wallet).map(publicCredential).sort((a, b) => b.createdAt - a.createdAt),
      requests: [...this.requests.values()].filter((record) => record.userId === userId && record.wallet === wallet).map(publicRequest).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100),
      events: this.auditEvents.filter((event) => event.wallet === wallet).slice(0, 100).map((event) => structuredClone(event)),
      security: {
        approvalModes: ['always-ask' as const, ...(automaticExecutionConfigured ? ['automatic' as const] : [])],
        automaticExecutionConfigured,
        fiatOnrampAvailable: false as const,
        arbitraryWalletAccess: false as const,
        credentialStorage: 'sha256-hash-only' as const,
      },
    };
  }

  policy(record: CredentialRecord): AgentPolicyInput {
    return structuredClone(record.policy);
  }

  summary(record: CredentialRecord): AgentCredentialSummary {
    return publicCredential(record);
  }

  recentRequests(record: CredentialRecord, limit: number): AgentRequest[] {
    return [...this.requests.values()]
      .filter((candidate) => candidate.credentialId === record.id)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, limit)
      .map(publicRequest);
  }

  capabilityRequest(record: CredentialRecord, id: string): AgentRequest {
    const request = this.requests.get(id);
    if (!request || request.credentialId !== record.id) {
      throw new AppError(404, 'AGENT_REQUEST_NOT_FOUND', 'This capability has no request with that ID.');
    }
    return publicRequest(request);
  }

  existingRequest(record: CredentialRecord, idempotencyKey: string, intent: AgentIntent): AgentRequest | null {
    const existing = [...this.requests.values()].find((candidate) => candidate.credentialId === record.id && candidate.idempotencyKey === idempotencyKey);
    if (!existing) return null;
    if (existing.fingerprint !== intentFingerprint(intent)) throw new AppError(409, 'AGENT_IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for a different agent request.');
    return publicRequest(existing);
  }

  createRequest(record: CredentialRecord, idempotencyKey: string, intent: AgentIntent, riskUsd: string): AgentRequest {
    this.sweep();
    const fingerprint = intentFingerprint(intent);
    const existing = this.existingRequest(record, idempotencyKey, intent);
    if (existing) return existing;
    if (this.requests.size >= MAX_REQUESTS) this.removeOldestTerminalRequest();
    if (this.requests.size >= MAX_REQUESTS) throw new AppError(503, 'AGENT_REQUEST_CAPACITY_REACHED', 'The approval queue is temporarily at capacity.', true);
    const now = Date.now();
    const request: RequestRecord = {
      id: randomUUID(),
      credentialId: record.id,
      credentialName: record.name,
      wallet: record.wallet,
      approvalMode: record.approvalMode,
      userId: record.userId,
      idempotencyKey,
      fingerprint,
      intent: structuredClone(intent),
      riskUsd,
      status: 'pending',
      createdAt: now,
      expiresAt: now + REQUEST_TTL_MS,
      reviewedAt: null,
      rejectedAt: null,
      failure: null,
      execution: null,
      prepared: null,
    };
    this.requests.set(request.id, request);
    this.audit(
      record.wallet,
      record.id,
      request.id,
      'request-created',
      record.approvalMode === 'automatic'
        ? `${intent.kind} request accepted for automatic execution within guardrails.`
        : `${intent.kind} request awaiting user approval.`,
    );
    return publicRequest(request);
  }

  ownedRequest(userId: string, wallet: string, id: string): RequestRecord {
    const record = this.requests.get(id);
    if (!record) throw new AppError(404, 'AGENT_REQUEST_NOT_FOUND', 'This agent request no longer exists.');
    if (record.userId !== userId || record.wallet !== wallet) throw new AppError(403, 'AGENT_REQUEST_FORBIDDEN', 'This agent request belongs to another wallet.');
    if ((record.status === 'pending' || record.status === 'prepared') && record.expiresAt <= Date.now()) {
      record.status = 'expired';
      record.prepared = null;
    }
    return record;
  }

  request(record: RequestRecord): AgentRequest {
    return publicRequest(record);
  }

  requestPolicy(record: RequestRecord): AgentPolicyInput {
    const credential = this.credentials.get(record.credentialId);
    if (!credential) throw new AppError(410, 'AGENT_CREDENTIAL_MISSING', 'The capability for this request is unavailable.');
    if (status(credential) !== 'active') throw new AppError(410, 'AGENT_CREDENTIAL_INACTIVE', 'The capability for this request is no longer active.');
    return structuredClone(credential.policy);
  }

  delegatedWalletId(record: RequestRecord): string {
    const credential = this.credentials.get(record.credentialId);
    if (!credential || status(credential) !== 'active') {
      throw new AppError(410, 'AGENT_CREDENTIAL_INACTIVE', 'The capability for this request is no longer active.');
    }
    if (credential.approvalMode !== 'automatic' || !credential.delegatedWalletId) {
      throw new AppError(409, 'AGENT_DELEGATION_MISSING', 'This capability has no delegated wallet for automatic execution.');
    }
    return credential.delegatedWalletId;
  }

  markPrepared(record: RequestRecord, prepared: AgentPreparedAction, automatic = false): AgentRequest {
    if (record.status !== 'pending') throw new AppError(409, 'AGENT_REQUEST_STATE_INVALID', 'Only pending requests can be prepared.');
    record.prepared = prepared;
    record.status = 'prepared';
    record.reviewedAt = Date.now();
    record.failure = null;
    this.audit(
      record.wallet,
      record.credentialId,
      record.id,
      'request-prepared',
      automatic ? 'Flay prepared and validated the exact transaction for automatic execution.' : 'User opened the exact transaction review.',
    );
    return publicRequest(record);
  }

  prepared(record: RequestRecord): AgentPreparedAction {
    if (record.status !== 'prepared' || !record.prepared) throw new AppError(409, 'AGENT_REQUEST_NOT_PREPARED', 'Review this request before signing it.');
    return record.prepared;
  }

  requeueExpiredPreparation(record: RequestRecord): void {
    if (record.status !== 'prepared' || !record.prepared) return;
    record.status = 'pending';
    record.prepared = null;
    record.reviewedAt = null;
    record.failure = 'The previous provider transaction expired and must be reviewed again.';
    this.audit(record.wallet, record.credentialId, record.id, 'request-failed', 'Expired provider transaction returned to the approval queue.');
  }

  reject(record: RequestRecord): AgentRequest {
    if (!['pending', 'prepared'].includes(record.status)) throw new AppError(409, 'AGENT_REQUEST_STATE_INVALID', 'This request can no longer be rejected.');
    record.status = 'rejected';
    record.rejectedAt = Date.now();
    record.prepared = null;
    this.audit(record.wallet, record.credentialId, record.id, 'request-rejected', 'User rejected the request.');
    return publicRequest(record);
  }

  noteFailure(record: RequestRecord, detail: string, terminal: boolean): void {
    record.failure = detail.slice(0, 500);
    if (terminal) record.status = 'failed';
    this.audit(record.wallet, record.credentialId, record.id, 'request-failed', terminal ? 'Request failed validation.' : 'Provider action failed and may be retried.');
  }

  complete(record: RequestRecord, execution: AgentExecutionSummary): AgentRequest {
    if (record.status === 'completed') return publicRequest(record);
    if (record.status !== 'prepared') throw new AppError(409, 'AGENT_REQUEST_STATE_INVALID', 'This request is not ready for execution.');
    record.status = 'completed';
    record.execution = execution;
    record.failure = null;
    record.prepared = null;
    this.audit(record.wallet, record.credentialId, record.id, 'request-completed', `Completed with ${execution.provider}.`);
    return publicRequest(record);
  }

  dailyRiskMicroUsd(credentialId: string): bigint {
    const since = Date.now() - 86_400_000;
    return [...this.requests.values()]
      .filter((record) => record.credentialId === credentialId && record.createdAt >= since && ['pending', 'prepared', 'completed'].includes(record.status))
      .reduce((total, record) => total + BigInt(record.riskUsd), 0n);
  }

  dailyX402RiskAtomic(credentialId: string): bigint {
    const since = Date.now() - 86_400_000;
    return [...this.requests.values()]
      .filter((record) => record.credentialId === credentialId
        && record.createdAt >= since
        && record.intent.kind === 'x402'
        && ['pending', 'prepared', 'completed'].includes(record.status))
      .reduce((total, record) => total + BigInt(record.riskUsd), 0n);
  }

  inFlightFuturesOpenCount(wallet: string, excludeRequestId?: string): number {
    return [...this.requests.values()].filter((record) => (
      record.wallet === wallet
      && record.id !== excludeRequestId
      && record.intent.kind === 'futures-open'
      && (record.status === 'pending' || record.status === 'prepared')
      && record.expiresAt > Date.now()
    )).length;
  }

  private ownedCredential(userId: string, wallet: string, id: string): CredentialRecord {
    const record = this.credentials.get(id);
    if (!record) throw new AppError(404, 'AGENT_CREDENTIAL_NOT_FOUND', 'This agent capability no longer exists.');
    if (record.userId !== userId || record.wallet !== wallet) throw new AppError(403, 'AGENT_CREDENTIAL_FORBIDDEN', 'This capability belongs to another wallet.');
    return record;
  }

  private consumeRateLimit(id: string) {
    const now = Date.now();
    const current = this.rateBuckets.get(id);
    const bucket = !current || current.resetAt <= now ? { resetAt: now + 60_000, count: 0 } : current;
    bucket.count += 1;
    this.rateBuckets.set(id, bucket);
    if (bucket.count > 30) throw new AppError(429, 'AGENT_RATE_LIMITED', 'This agent capability submitted too many requests. Wait one minute.', true);
  }

  private audit(wallet: string, credentialId: string | null, requestId: string | null, type: AgentAuditEvent['type'], detail: string) {
    this.auditEvents.unshift({ id: randomUUID(), wallet, credentialId, requestId, type, detail, createdAt: Date.now() });
    if (this.auditEvents.length > MAX_AUDIT_EVENTS) this.auditEvents.length = MAX_AUDIT_EVENTS;
  }

  private removeOldestTerminalRequest() {
    const record = [...this.requests.values()].reverse().find((candidate) => ['rejected', 'expired', 'failed', 'completed'].includes(candidate.status));
    if (record) this.requests.delete(record.id);
  }

  private sweep() {
    const now = Date.now();
    for (const request of this.requests.values()) {
      if ((request.status === 'pending' || request.status === 'prepared') && request.expiresAt <= now) {
        request.status = 'expired';
        request.prepared = null;
      }
    }
    for (const [id, bucket] of this.rateBuckets) if (bucket.resetAt <= now) this.rateBuckets.delete(id);
  }
}

export type AgentCredentialRecord = ReturnType<AgentStore['authenticate']>;
export type AgentRequestRecord = ReturnType<AgentStore['ownedRequest']>;
