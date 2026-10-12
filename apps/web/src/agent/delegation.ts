export const AGENT_DELEGATION_WAIT_MS = 45_000;

export async function waitForAgentDelegation(
  delegation: Promise<void>,
  timeoutMs = AGENT_DELEGATION_WAIT_MS,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('Privy did not finish granting Full access. Retry and keep this page open until authorization completes.')), timeoutMs);
  });

  try {
    await Promise.race([delegation, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
