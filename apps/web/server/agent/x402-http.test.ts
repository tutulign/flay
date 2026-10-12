import { describe, expect, it } from 'vitest';
import { isPublicX402Address, resolvePublicX402Addresses, validateX402Target } from './x402-http.js';

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
});
