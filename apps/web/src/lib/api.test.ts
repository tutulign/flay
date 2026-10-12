import { describe, expect, it } from 'vitest';
import { ApiClientError, readableError } from './api';

describe('readableError', () => {
  it('shows the first structured validation detail instead of a generic wrapper', () => {
    const error = new ApiClientError(
      'Some submitted fields are invalid.',
      'INVALID_REQUEST',
      400,
      false,
      { formErrors: [], fieldErrors: { x402AllowedOrigins: ['x402 access requires at least one allowed HTTPS origin.'] } },
    );
    expect(readableError(error)).toBe('x402 access requires at least one allowed HTTPS origin.');
  });
});
