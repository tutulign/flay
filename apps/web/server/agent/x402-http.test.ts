import { EventEmitter } from 'node:events';
import https from 'node:https';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { isPublicX402Address, resolvePublicX402Addresses, SafeX402HttpTransport, validateX402Target } from './x402-http.js';

function scriptedTransport(status: number, responseHeaders: Record<string, string>, body: string | Buffer) {
  let capturedOptions: https.RequestOptions | null = null;
  const requester = ((options: https.RequestOptions, callback: (response: PassThrough & { statusCode: number; headers: Record<string, string> }) => void) => {
    capturedOptions = options;
    const request = new EventEmitter() as EventEmitter & {
      setTimeout(ms: number, handler: () => void): unknown;
      destroy(error?: Error): unknown;
      write(chunk: string): boolean;
      end(): void;
    };
    request.setTimeout = () => request;
    request.destroy = (error?: Error) => {
      if (error) queueMicrotask(() => request.emit('error', error));
      return request;
    };
    request.write = () => true;
    request.end = () => {
      const response = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string> };
      response.statusCode = status;
      response.headers = responseHeaders;
      callback(response);
      response.end(body);
    };
    return request;
  }) as unknown as typeof https.request;
  const transport = new SafeX402HttpTransport(
    async () => [{ address: '8.8.8.8', family: 4 }],
    requester,
  );
  return { transport, options: () => capturedOptions };
}

describe('x402 HTTPS boundary', () => {
  it('accepts public addresses and rejects local, private, metadata, reserved, and documentation ranges', () => {
    expect(isPublicX402Address('8.8.8.8')).toBe(true);
    expect(isPublicX402Address('2606:4700:4700::1111')).toBe(true);
    for (const denied of [
      '127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1',
      '192.168.1.1', '192.0.2.1', '198.18.0.1', '198.51.100.2', '203.0.113.3',
      '::1', 'fc00::1', 'fd00::1', 'fe80::1', 'ff02::1', '2001:db8::1',
      '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::',
    ]) expect(isPublicX402Address(denied), denied).toBe(false);
  });

  it('requires a credential-free HTTPS hostname on the default port', () => {
    expect(validateX402Target('https://api.example.com/data?q=sol').toString()).toBe('https://api.example.com/data?q=sol');
    for (const denied of [
      'http://api.example.com/data',
      'https://user:secret@api.example.com/data',
      'https://api.example.com:8443/data',
      'https://api.example.com/data#fragment',
      'https://127.0.0.1/data',
      'https://[::1]/data',
      'https://[::ffff:7f00:1]/data',
      'https://localhost/data',
      'https://service.local/data',
    ]) expect(() => validateX402Target(denied), denied).toThrow();
  });

  it('fails closed when any DNS answer is private to resist rebinding', async () => {
    await expect(resolvePublicX402Addresses('api.example.com', async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.7', family: 4 },
    ])).rejects.toMatchObject({ code: 'X402_DESTINATION_DENIED' });
    await expect(resolvePublicX402Addresses('api.example.com', async () => [
      { address: '8.8.8.8', family: 4 },
    ])).resolves.toEqual([{ address: '8.8.8.8', family: 4 }]);
    await expect(resolvePublicX402Addresses('api.example.com', async () => {
      throw new Error('resolver failed');
    })).rejects.toMatchObject({ code: 'X402_DNS_UNAVAILABLE', retryable: true });
  });

  it('rejects redirects and oversized responses without forwarding ambient credentials', async () => {
    const input = {
      url: 'https://api.example.com/report', method: 'GET' as const,
      idempotencyKey: crypto.randomUUID(), paymentSignature: 'x402-payment',
    };
    const redirect = scriptedTransport(302, { location: 'https://other.example/report' }, 'redirect');
    await expect(redirect.transport.request(input)).rejects.toMatchObject({ code: 'X402_REDIRECT_DENIED' });

    const oversized = scriptedTransport(200, { 'content-type': 'text/plain' }, Buffer.alloc(64 * 1024 + 1));
    await expect(oversized.transport.request(input)).rejects.toMatchObject({ code: 'X402_RESPONSE_TOO_LARGE' });

    const sentHeaders = redirect.options()?.headers as Record<string, string>;
    expect(sentHeaders['payment-signature']).toBe('x402-payment');
    expect(sentHeaders['idempotency-key']).toBe(input.idempotencyKey);
    expect(sentHeaders).not.toHaveProperty('authorization');
    expect(sentHeaders).not.toHaveProperty('cookie');
  });

  it('returns pinned DNS answers in the shape requested by current and legacy Node clients', async () => {
    const request = scriptedTransport(402, { 'content-type': 'application/json' }, '{}');
    await expect(request.transport.request({
      url: 'https://api.example.com/report', method: 'GET',
      idempotencyKey: crypto.randomUUID(),
    })).resolves.toMatchObject({ status: 402 });

    const pinnedLookup = request.options()?.lookup as unknown as (
      hostname: string,
      options: unknown,
      callback: (...args: unknown[]) => void,
    ) => void;
    expect(pinnedLookup).toBeTypeOf('function');

    const allResult = await new Promise<unknown[]>((resolve, reject) => {
      pinnedLookup('api.example.com', { all: true }, (error, addresses) => {
        if (error) reject(error);
        else resolve(addresses as unknown[]);
      });
    });
    expect(allResult).toEqual([{ address: '8.8.8.8', family: 4 }]);

    const singleResult = await new Promise<{ address: unknown; family: unknown }>((resolve, reject) => {
      pinnedLookup('api.example.com', {}, (error, address, family) => {
        if (error) reject(error);
        else resolve({ address, family });
      });
    });
    expect(singleResult).toEqual({ address: '8.8.8.8', family: 4 });
  });
});
