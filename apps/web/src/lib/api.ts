import type { ApiErrorBody } from '../../shared/types';

export class ApiClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly retryable: boolean,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export async function api<T>(
  path: string,
  options: RequestInit & { identityToken?: string | null } = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (options.identityToken) headers.set('x-privy-identity-token', options.identityToken);
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiClientError('Flay cannot reach its server. Check your connection and retry.', 'NETWORK_ERROR', 0, true);
  }

  const payload = await response.json().catch(() => null) as T | ApiErrorBody | null;
  if (!response.ok) {
    const error = payload && typeof payload === 'object' && 'error' in payload ? payload.error : null;
    throw new ApiClientError(
      error?.message ?? 'Flay could not complete this request.',
      error?.code ?? 'HTTP_ERROR',
      response.status,
      error?.retryable ?? response.status >= 500,
      error?.details,
    );
  }
  return payload as T;
}

export function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined) search.set(key, String(value));
  });
  return search.toString();
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function toBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function readableError(error: unknown): string {
  if (error instanceof ApiClientError) {
    const details = error.details as { formErrors?: unknown; fieldErrors?: unknown } | undefined;
    const fieldErrors = details?.fieldErrors && typeof details.fieldErrors === 'object'
      ? Object.values(details.fieldErrors as Record<string, unknown>)
      : [];
    const detail = [details?.formErrors, ...fieldErrors]
      .flatMap((value) => Array.isArray(value) ? value : [])
      .find((value): value is string => typeof value === 'string' && value.length > 0);
    return detail ?? error.message;
  }
  if (error instanceof Error) {
    if (/reject|denied|cancel/i.test(error.message)) return 'The wallet signature was rejected. Nothing was submitted.';
    return error.message;
  }
  return 'Something went wrong. Try again.';
}
