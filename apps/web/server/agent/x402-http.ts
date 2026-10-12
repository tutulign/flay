import { lookup } from 'node:dns/promises';
import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import ipaddr from 'ipaddr.js';
import { AppError } from '../errors.js';

const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;
const DNS_TIMEOUT_MS = 4_000;

export interface X402HttpRequest {
  url: string;
  method: 'GET' | 'POST';
  body?: string;
  idempotencyKey: string;
  paymentSignature?: string;
}

export interface X402HttpResponse {
  status: number;
  headers: ReadonlyMap<string, string>;
  body: string;
  bodyTruncated: boolean;
  contentType: string;
}

export interface X402HttpTransport {
  request(input: X402HttpRequest): Promise<X402HttpResponse>;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

type X402AddressResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export function isPublicX402Address(value: string): boolean {
  try {
    const parsed = ipaddr.parse(value.split('%')[0]);
    // ipaddr classifies loopback, private, link-local, multicast, documentation,
    // transition, mapped, benchmarking, carrier-grade NAT, and reserved ranges.
    return parsed.range() === 'unicast';
  } catch { return false; }
}

export function validateX402Target(rawUrl: string): URL {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new AppError(400, 'X402_URL_INVALID', 'The x402 URL is invalid.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port) {
    throw new AppError(400, 'X402_URL_UNSAFE', 'x402 requests require HTTPS without credentials, fragments, or a custom port.');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(hostname) || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new AppError(403, 'X402_DESTINATION_DENIED', 'This x402 destination is not a public HTTPS service.');
  }
  return url;
}

export async function resolvePublicX402Addresses(
  hostname: string,
  resolver: (hostname: string) => Promise<ResolvedAddress[]> = async (host) => {
    const records = await lookup(host, { all: true, verbatim: true });
    return records
      .filter((record): record is typeof record & { family: 4 | 6 } => record.family === 4 || record.family === 6)
      .map((record) => ({ address: record.address, family: record.family }));
  },
): Promise<ResolvedAddress[]> {
  let addresses: ResolvedAddress[];
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    addresses = await Promise.race([
      resolver(hostname),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('DNS timeout')), DNS_TIMEOUT_MS);
      }),
    ]);
  } catch {
    throw new AppError(502, 'X402_DNS_UNAVAILABLE', 'The x402 service hostname could not be resolved.', true);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  const unique = [...new Map(addresses.map((entry) => [`${entry.family}:${entry.address}`, entry])).values()];
  if (!unique.length || unique.some((entry) => !isPublicX402Address(entry.address))) {
    throw new AppError(403, 'X402_DESTINATION_DENIED', 'The x402 hostname resolved to a private or reserved network.');
  }
  return unique;
}

function normalizedHeaders(headers: IncomingHttpHeaders): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) result.set(key.toLowerCase(), value.join(', '));
    else if (typeof value === 'string') result.set(key.toLowerCase(), value);
  }
  return result;
}

export class SafeX402HttpTransport implements X402HttpTransport {
  constructor(
    private readonly resolver: X402AddressResolver = resolvePublicX402Addresses,
    private readonly requester: typeof https.request = https.request,
  ) {}

  async request(input: X402HttpRequest): Promise<X402HttpResponse> {
    const url = validateX402Target(input.url);
    const body = input.body ?? '';
    if (input.method === 'GET' && body) throw new AppError(400, 'X402_BODY_INVALID', 'GET x402 requests cannot include a body.');
    if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) throw new AppError(413, 'X402_BODY_TOO_LARGE', 'The x402 request body exceeds 8 KiB.');
    if (!/^[0-9a-f-]{36}$/i.test(input.idempotencyKey)) throw new AppError(400, 'X402_IDEMPOTENCY_INVALID', 'The x402 idempotency key is invalid.');
    if (input.paymentSignature && input.paymentSignature.length > 32 * 1024) throw new AppError(400, 'X402_PAYMENT_HEADER_TOO_LARGE', 'The x402 payment header is too large.');

    const addresses = await this.resolver(url.hostname);
    const target = addresses[0];
    const headers: Record<string, string> = {
      accept: 'application/json, text/plain;q=0.9',
      'user-agent': 'Flay-x402/1.0',
      'idempotency-key': input.idempotencyKey,
      connection: 'close',
    };
    if (input.method === 'POST') {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(body, 'utf8'));
    }
    if (input.paymentSignature) headers['payment-signature'] = input.paymentSignature;

    return await new Promise<X402HttpResponse>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        if (error instanceof AppError) reject(error);
        else reject(new AppError(502, 'X402_SERVICE_UNAVAILABLE', 'The x402 service could not be reached.', true));
      };
      const request = this.requester({
        protocol: 'https:',
        hostname: url.hostname,
        port: 443,
        servername: url.hostname,
        method: input.method,
        path: `${url.pathname}${url.search}`,
        headers,
        agent: false,
        lookup: ((_hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
          if (typeof options === 'object' && options !== null && 'all' in options && options.all === true) {
            callback(null, addresses.map(({ address, family }) => ({ address, family })));
            return;
          }
          callback(null, target.address, target.family);
        }) as https.RequestOptions['lookup'],
      }, (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.resume();
          fail(new AppError(502, 'X402_REDIRECT_DENIED', 'The x402 service attempted a redirect. Allowlist the final HTTPS origin directly.'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        const complete = (bodyTruncated: boolean) => {
          if (settled) return;
          settled = true;
          const responseHeaders = normalizedHeaders(response.headers);
          resolve({
            status,
            headers: responseHeaders,
            body: Buffer.concat(chunks).toString('utf8'),
            bodyTruncated,
            contentType: responseHeaders.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '',
          });
        };
        response.on('data', (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const remaining = MAX_RESPONSE_BYTES - size;
          if (bytes.length > remaining) {
            if (remaining > 0) chunks.push(bytes.subarray(0, remaining));
            size = MAX_RESPONSE_BYTES;
            complete(true);
            response.destroy();
            request.destroy();
            return;
          }
          size += bytes.length;
          chunks.push(bytes);
        });
        response.on('end', () => complete(false));
        response.on('error', fail);
      });
      request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error('timeout')));
      request.on('error', fail);
      if (body) request.write(body);
      request.end();
    });
  }
}
