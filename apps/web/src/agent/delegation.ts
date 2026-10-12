export const AGENT_DELEGATION_WAIT_MS = 15_000;

export type AgentDelegationOutcome = 'completed' | 'verification-needed';

export async function waitForAgentDelegation(
  delegation: Promise<void>,
  timeoutMs = AGENT_DELEGATION_WAIT_MS,
): Promise<AgentDelegationOutcome> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<AgentDelegationOutcome>((resolve) => {
    timeout = setTimeout(() => resolve('verification-needed'), timeoutMs);
  });

  try {
    return await Promise.race([
      delegation.then(() => 'completed' as const),
      deadline,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
