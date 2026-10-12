import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForAgentDelegation } from './delegation.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('Agent wallet delegation wait', () => {
  it('reports completed delegation', async () => {
    await expect(waitForAgentDelegation(Promise.resolve(), 100)).resolves.toBeUndefined();
  });

  it('preserves a Privy rejection', async () => {
    await expect(waitForAgentDelegation(Promise.reject(new Error('User cancelled')), 100))
      .rejects.toThrow('User cancelled');
  });

  it('never creates a credential while the Privy operation is unresolved', async () => {
    vi.useFakeTimers();
    const result = waitForAgentDelegation(new Promise<void>(() => undefined), 100);
    const rejection = expect(result).rejects.toThrow('Privy did not finish granting Full access');
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
  });
});
