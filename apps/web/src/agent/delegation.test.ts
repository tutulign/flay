import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForAgentDelegation } from './delegation.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('Agent wallet delegation wait', () => {
  it('reports completed delegation', async () => {
    await expect(waitForAgentDelegation(Promise.resolve(), 100)).resolves.toBe('completed');
  });

  it('preserves a Privy rejection', async () => {
    await expect(waitForAgentDelegation(Promise.reject(new Error('User cancelled')), 100))
      .rejects.toThrow('User cancelled');
  });

  it('hands a stalled browser promise to server verification after the deadline', async () => {
    vi.useFakeTimers();
    const result = waitForAgentDelegation(new Promise<void>(() => undefined), 100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toBe('verification-needed');
  });
});
