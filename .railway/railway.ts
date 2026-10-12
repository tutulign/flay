import { defineRailway, preserve, project, service } from "railway/iac";

// This repository owns only the Flay service in its Railway project.
export const partial = "flay";

export default defineRailway(() => {
  const flay = service("flay", {
    deploy: {
      numReplicas: 1,
      healthcheckPath: "/",
      healthcheckTimeout: 300,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
    },
    env: {
      NODE_ENV: preserve(),
      PRIVY_APP_ID: preserve(),
      PRIVY_APP_SECRET: preserve(),
      PRIVY_AUTHORIZATION_PRIVATE_KEY: preserve(),
      PRIVY_VERIFICATION_KEY: preserve(),
      PROVIDER_TIMEOUT_MS: preserve(),
      SOLANA_RPC_URL: preserve(),
      SOLANA_RPC_WS_URL: preserve(),
      VITE_PRIVY_APP_ID: preserve(),
      VITE_PRIVY_ONRAMP_ENV: preserve(),
    },
  });

  return project("flay", {
    resources: [flay],
  });
});
