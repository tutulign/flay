# Flay implementation record

## Active plan: Privy TEE Full access provisioning

**Status:** in progress
**Date:** 2026-10-12
**Scope:** repair Full access credential creation and production MCP execution for Privy TEE/unified Solana wallets by provisioning and verifying Flay's exact authorization-key signer, exposing capability/request outcomes, and removing provider-data inconsistencies that block guarded execution

### Implementation plan

1. Replace the legacy-only delegated-actions path for TEE wallets with Privy's current `useSigners` flow, using the public authorization-key ID while retaining legacy delegation compatibility for older on-device wallets.
2. Never continue to credential creation while the Privy consent operation is unresolved. Surface cancellation, provider errors, and a bounded timeout directly to the user.
3. Require the matching authorization-key ID in server automatic-execution readiness and verify that exact signer appears on the exact Privy wallet before creating or using a Full access credential.
4. Add the public signer-ID configuration to the environment example, Railway configuration, and Docker/Vite build arguments so the deployed browser bundle receives it; keep the authorization private key server-only.
5. Add focused client and server tests for TEE signer provisioning, timeout behavior, exact-signer verification, mismatch denial, and unchanged legacy behavior.
6. Update the README, run the complete checks and security scans, deploy, verify production readiness, and compare every result with this plan before marking it complete.
7. Add MCP read tools that report the authenticated capability's real approval mode and policy boundary, list its own recent requests, and return one request's status, failure, transaction signature, Explorer URL, and live onchain confirmation without exposing another credential's records.
8. Hydrate canonical SOL/JUP exact-mint results with a live Jupiter USD price so guardrail valuation agrees with symbol search and SOL-input automatic Convert requests are not rejected solely because static core metadata has no price.
9. Restrict MCP token discovery to verified, tradable assets, rank canonical exact-symbol matches first, and exclude unverified USDC lookalikes from agent discovery.
10. Make MCP xStocks discovery await the bounded complete official Solana directory or return a clear retryable provider error instead of reporting a deliberately partial warm-up catalog as usable discovery.

### Acceptance criteria

1. A TEE Solana wallet can grant Full access through Privy's current signer API and Flay creates the capability only after Privy confirms the operation.
2. Flay's server accepts only the configured authorization key on the authenticated user's exact Solana wallet; another delegation cannot satisfy the check.
3. A stalled or rejected Privy operation cannot fall through to credential creation and produces a clear retryable message.
4. Older on-device wallets retain their supported delegated-actions path.
5. The deployed browser bundle contains the configured public signer ID, while the app secret and authorization private key remain server-only and absent from tracked files and browser bundles.
6. Existing Agent, MCP, Convert, Stocks, Futures, authentication, and funding checks remain passing in production.
7. An MCP client can verify whether its credential is Full access or Always ask and can inspect only its own request lifecycle, failure, signature, Explorer link, and live Solana confirmation.
8. Exact SOL mint lookup returns the same usable live-price class as SOL symbol lookup, allowing policy valuation for SOL-input conversions while still failing closed when no live price can be obtained.
9. MCP token search never recommends unverified or blocked assets and returns canonical USDC ahead of any other verified symbol match.
10. MCP stock discovery returns a complete official directory or an explicit retryable failure; it never labels the one-asset warm-up response as a completed discovery result.

### Completion rule

Do not declare this fix complete until code, configuration, tests, release scans, and the live deployment match this plan. User consent itself remains an explicit wallet-owner action.

## Active plan: RPCFast HTTP and WebSocket transport

**Status:** complete
**Date:** 2026-10-12
**Scope:** replace the primary Solana RPC with the supplied RPCFast endpoint and add its paired WebSocket transport without exposing either credential to the browser

### Implementation plan

1. Add a server-only `SOLANA_RPC_WS_URL` setting and pass it to the primary Solana `Connection` as `wsEndpoint`; retain HTTP as the required request transport and preserve the existing HTTP fallback.
2. Add the WebSocket setting to the environment example and Railway infrastructure definition without committing the supplied credential.
3. Set the supplied HTTP and WSS endpoints in the ignored local environment and linked Railway service.
4. Add focused configuration coverage, run the required check and release audit, verify both endpoints safely, compare the result with this plan, and record the completion audit here.

### Acceptance criteria

1. Server-side Solana requests use the supplied RPCFast HTTPS endpoint and subscriptions use the supplied RPCFast WSS endpoint.
2. RPC credentials do not enter the browser bundle, tracked source, logs, or test snapshots.
3. The existing HTTP fallback and rate limiting continue to work.
4. Type checking, tests, production build, release audit, endpoint probes, and production health verification pass.

### Completion rule

Do not declare this update complete until the code, local configuration, Railway configuration, verification results, and this plan agree.

## RPCFast HTTP and WebSocket transport audit

**Status:** complete
**Date:** 2026-10-12

### Plan-to-code comparison

1. **Paired transports — pass.** `server/config.ts` reads the server-only `SOLANA_RPC_WS_URL`, and `server/rpc.ts` passes it to the primary Solana `Connection` as `wsEndpoint`. HTTPS remains the request transport, while the existing independently rate-limited HTTP fallback remains unchanged.
2. **Configuration surfaces — pass.** `.env.example` documents the WSS setting without a credential, `.railway/railway.ts` preserves it, the ignored local `.env` contains the supplied HTTPS/WSS pair, and Railway accepted both production variables without printing their values.
3. **Focused and live verification — pass.** The transport test proves that Web3 receives separate HTTP and WSS endpoints. A direct mainnet probe obtained a blockhash over HTTPS and a live slot notification over WSS. The complete check passed with 330 tests and 8 credential-gated skips, and the production build succeeded.
4. **Security and release verification — pass.** The release audit scanned 246 browser bundle files successfully. Diff checks and a tracked-source hostname scan confirmed that the supplied credential is absent from Git and browser artifacts.
5. **Production — pass.** Railway deployment `e521d2d0-a80e-407e-b823-2f7314dbe8ae` is online. The live health endpoint returns `status: ok`, identifies `solana-rpc.rpcfast.com` as the RPC provider, obtains a latest blockhash, and accepts a current v0 simulation probe.

### Acceptance-criteria result

All four acceptance criteria pass. Flay now uses the supplied RPCFast HTTPS endpoint for server RPC calls and the paired WSS endpoint for subscriptions, while retaining HTTP rate limiting and fallback behavior and keeping both credential-bearing URLs out of tracked and browser-visible code.

## Permanent completion rule

Before implementing a new block, write its plan and acceptance criteria here. Before declaring it complete, compare the final repository with every requirement, run the relevant build, test, security, and live checks, and add a plan-to-code completion audit here. Do not stop at a visually finished interface when execution, recovery, security, or evidence remains incomplete.

## Completed plan: repository documentation cleanup

**Status:** complete
**Date:** 2026-09-28
**Scope:** remove obsolete documentation from the GitHub repository and replace the root README with one professional, accurate project guide

### Implementation plan

1. Inventory every tracked file and classify documentation as required operational guidance, repository instructions, or historical implementation evidence.
2. Retain only `README.md`, `AGENTS.md`, and `agent.md` as project-authored Markdown files. Consolidate current setup, architecture, feature, security, testing, deployment, and limitation details into the root README before removing duplicate component documentation.
3. Remove superseded plans, audits, acceptance notes, research notes, status checkpoints, duplicated nested READMEs, and the vendored package README. Do not remove source, tests, lockfiles, deployment configuration, environment examples, or Rust audit configuration.
4. Rewrite `AGENTS.md` as concise durable repository rules without references to deleted history. Rewrite `agent.md` as the concise permanent completion rule plus this cleanup plan and its final audit.
5. Verify that no source, script, package manifest, Docker build, or configuration file references a removed document.
6. Run the production build, full test suite, release audit, Markdown-link check, secret/tracked-artifact scan, Docker-context review, and live deployment health checks.
7. Compare the final repository against every acceptance criterion, embed the completion audit in `agent.md`, remove the temporary plan file so it does not become new clutter, then commit and push the cleanup to `main`.

### Acceptance criteria

1. The repository contains only the three necessary project-authored Markdown files: `README.md`, `AGENTS.md`, and `agent.md`.
2. The root README accurately explains Flay, its live features, architecture, trust boundaries, prerequisites, local setup, environment configuration, scripts, deployment, project structure, and current limitations.
3. All historical and duplicated documentation is removed without deleting runtime source, tests, lockfiles, infrastructure, environment examples, or required third-party package code.
4. No retained source or configuration references a removed Markdown file, and every relative link in the retained Markdown resolves.
5. Build, TypeScript checking, full tests, release scan, and live Railway health verification pass after cleanup.
6. No secret, real `.env`, dependency tree, build output, log, PID, or local artifact becomes tracked.
7. The final plan-to-repository audit is embedded in `agent.md`, Git is clean after commit, and `origin/main` contains the cleanup.

### Completion rule

Do not declare the cleanup complete until the final tracked-file inventory, repository checks, live checks, and embedded plan-to-code audit pass.

## Repository documentation cleanup audit

**Status:** complete
**Date:** 2026-09-28

### Plan-to-repository comparison

1. **Documentation inventory — pass.** The pre-cleanup Git tree contained 78 Markdown files. Seventy-five historical plans, audits, status notes, research notes, duplicate component READMEs, and vendored explanatory files are removed. The intended final tree retains only `README.md`, `AGENTS.md`, and `agent.md`.
2. **Professional root README — pass.** `README.md` now covers the product, live URL, shipped features, architecture, transaction flow, trust model, technology, repository structure, prerequisites, local setup, environment variables, Privy configuration, commands, dependency advisories, Railway deployment, and current product boundaries.
3. **Runtime preservation — pass.** Every staged deletion is a Markdown file. Source, tests, package manifests, lockfiles, Docker/Railway configuration, `.env.example`, the Rust audit configuration, and the vendored compatibility implementation remain present. A fresh `npm ci --ignore-scripts` installed 955 packages and the four required `bigint-buffer` exports loaded successfully.
4. **References and links — pass.** No retained source or configuration references a removed document. All relative links in the retained documentation resolve. The Rust audit exception rationale was consolidated into the root README and its configuration comment points to that retained section.
5. **Build and live verification — pass.** `npm run check` completed the TypeScript and Vite production build; 270 tests passed and 8 credential/mainnet-gated tests remained explicitly skipped. `npm run release:audit` passed across 246 bundle files. The live root, health, Futures, Stocks, and Convert discovery endpoints returned HTTP 200; health returned `ok`, GMTrade returned `ready`, and xStocks returned its complete 1,124-asset catalog.
6. **Security and artifact checks — pass.** `npm audit --omit=dev --audit-level=high` passed with three disclosed low-severity MagicBlock dependency findings. `cargo audit` passed with the six documented exceptions and 11 allowed maintenance/soundness warnings. No real `.env`, secret value, dependency tree, build output, Rust target, artifact, log, or PID is included in the intended Git tree. `.dockerignore` contains every required exclusion and the Dockerfile has no broad `COPY .` instruction.
7. **GitHub synchronization — pass.** The verified cleanup commit `01eb8e9` was pushed to `origin/main`. The post-push check confirmed a clean working tree, local `HEAD` equal to `origin/main`, and exactly the three required Markdown files in the committed tree. This embedded completion record is the sole follow-up documentation change.

## Completed plan: user-controlled AI agent access

**Status:** complete
**Date:** 2026-09-28
**Scope:** let an external AI agent request Convert, xStocks, and Futures actions against the user's existing Privy Solana wallet while requiring the user to approve and sign every value-changing transaction; fiat funding and arbitrary wallet operations remain unavailable to the agent

### Security model

The AI model never receives a wallet private key, Privy identity token, unsigned provider transaction, or general-purpose signing method. An agent receives a revocable, wallet-bound capability credential that can only create structured requests. Flay validates each request against the user's guardrails and places it in an approval queue. The authenticated user reviews the resolved venue, amounts, fees, slippage, leverage, and transaction details before the existing Privy wallet signs. The agent credential cannot approve, sign, submit, fund, export, transfer, or change its own policy.

### Implementation plan

1. Add shared, strictly typed agent policy, capability, intent, approval, execution, and audit-event contracts for Convert, xStocks, and Futures. Use deny-by-default schemas and reject unknown fields.
2. Build a bounded server-side agent store with hashed capability credentials, wallet and Privy-user ownership binding, expirations, one active policy revision per credential, request TTLs, idempotency, approval state transitions, revocation, and a capped audit trail. Never persist a plaintext credential.
3. Add an agent service that validates intent semantics and enforces user guardrails: enabled products, per-action approval, maximum USD value, rolling daily requested value, slippage, futures leverage, permitted token mints, stock symbols, futures markets, and credential expiry. Risk-increasing actions always require authenticated user approval.
4. Expose two separated API surfaces. User-management and approval routes require the existing Privy identity and wallet binding. The external submission route accepts only the agent capability credential and structured trading intents. Do not expose fiat funding, wallet transfer, arbitrary transaction, message-signing, key-export, MagicBlock, or policy-management tools to an agent.
5. Resolve approved requests through Flay's existing live providers and transaction builders. Reuse Convert, xStocks, Phoenix, and GMTrade validation, simulation, prepared-transaction expiry, signer binding, submission, and reconciliation paths rather than accepting transactions or venue output from the AI.
6. Add an Agent workspace to the authenticated application where users configure guardrails, create or revoke agent access, copy the credential once, inspect pending requests and history, reject requests, and approve requests. Approval must present a final review and invoke the user's existing Privy transaction-signing flow.
7. Make execution recovery explicit: expired, rejected, revoked, failed, and completed states remain visible; retry cannot duplicate a completed action; provider degradation preserves the approval record and returns a recoverable error.
8. Add focused service, schema, API-auth, policy, idempotency, fiat-denial, and UI tests. Confirm that an agent credential cannot call identity-protected fiat endpoints or obtain any general signing ability.
9. Update the root README with the final Agent architecture, supported capability boundary, configuration, API workflow, and trust limitations. Do not add another Markdown file.
10. Run the production build, complete test suite, release audit, dependency audit, tracked-secret/artifact scan, and safe live health checks. Compare every plan item and acceptance criterion with the final repository and embed the completion audit below this plan before declaring completion.

### Acceptance criteria

1. A user can create and revoke a wallet-bound agent credential and configure explicit Convert, xStocks, and Futures guardrails from Flay.
2. An external agent can submit only documented structured intents. All unknown action types, unknown fields, unsupported assets or markets, excessive amounts, leverage, slippage, expired credentials, revoked credentials, duplicate requests, and attempts outside the policy are rejected.
3. Every risk-increasing transaction requires a separate authenticated user approval and a Privy signature from the same embedded wallet. Possession of the agent credential alone can never move funds.
4. Convert and stock requests use live Flay aggregation and transaction validation. Futures requests use live Phoenix/GMTrade routing and their semantic transaction validators. The AI cannot provide a transaction or force a venue outside the reviewed route.
5. Fiat onramp, arbitrary send, MagicBlock, private-key export, message signing, policy mutation, approval, and transaction submission are absent from the agent capability surface and covered by negative tests.
6. Credentials are returned once, stored only as hashes, expire, are revocable, are rate-limited, and never appear in logs, activity payloads, URLs, or client persistence.
7. Pending approvals, policy status, credential status, execution results, failures, expiry, rejection, and revocation are clearly represented in an accessible responsive UI.
8. Existing Convert, Futures, Stocks, Funds, MagicBlock, wallet export, and gasless paths continue to pass their existing tests and production build.
9. README documentation and the embedded plan-to-code audit accurately describe what is cryptographically enforced, what Flay enforces server-side, and the fact that the user signs every value-changing action.

### Completion rule

Do not declare this Agent block complete until all supported actions execute through the same reviewed transaction paths as their manual counterparts, fiat and general wallet access are proven absent from the agent surface, the complete checks pass, and the plan-to-code audit has no pending criterion.

## User-controlled AI agent access audit

**Status:** complete
**Date:** 2026-09-28

### Plan-to-code comparison

1. **Contracts and deny-by-default parsing — pass.** `shared/agent.ts` defines the policy, capability, four supported intent shapes, approval states, prepared actions, execution results, workspace, and audit events. Strict discriminated Zod schemas reject unknown fields, unsupported kinds, invalid Solana addresses, invalid amounts, irrelevant futures fields, and policy combinations that cannot safely enable a selected product.
2. **Bounded capability and approval store — pass.** `server/agent/store.ts` generates a 256-bit one-time secret, retains only its SHA-256 hash, uses constant-time comparison, binds every record to the Privy user and Solana wallet, enforces credential and request expiry, caps credentials/requests/audit events, rate-limits credentials, detects conflicting idempotency reuse, records state transitions, and revokes access immediately. An identical retry returns the original request without consuming the rolling limit twice.
3. **Policy enforcement — pass.** `server/agent/service.ts` enforces product, token, stock, market, per-request USD, rolling 24-hour USD, slippage, leverage, position-count, credential-status, and expiry limits before preparing a transaction. Revocation is rechecked at review and execution. Expired provider preparations return to the queue for a fresh review.
4. **Separated API authority — pass.** Privy identity plus exact wallet binding protects credential management, workspace, review, rejection, and execution. Only `POST /api/agent/requests` accepts a capability bearer token. Its schema contains Convert, xStocks, Futures open, Futures close, and Futures cancel; fiat, send, MagicBlock, export, message signing, arbitrary instructions, policy mutation, approval, and direct submission have no capability route. An explicit unsupported-kind guard returns `AGENT_ACTION_NOT_ALLOWED`.
5. **Existing provider execution paths — pass.** Convert selects Flay's best live Jupiter/Raydium/Orca quote and uses `QuoteService.prepare/execute`; xStocks uses `StockService.quote` followed by the same validated market path; Futures obtains live Phoenix/GMTrade route quotes and uses `FuturesTransactionService.prepare/execute`. The agent supplies structured economic intent only and cannot supply transaction bytes or bypass the existing signer, semantic checks, simulation, prepared expiry, or reconciliation.
6. **Responsive Agent workspace — pass.** Desktop and mobile navigation expose guardrail configuration, one-time credential copy, revocation, policy summaries, approval queue, rejection, exact provider review, Privy approval, completion links, terminal request history, failures, expiry, and a wallet audit trail. The UI states that the agent cannot sign and that fiat/general wallet actions are unavailable.
7. **Recovery and idempotency — pass.** Pending, prepared, rejected, expired, failed, and completed states remain visible. Provider failures stay attached to the request; unexpired prepared actions are retryable; expired transactions are rebuilt only after returning to pending; completed actions cannot execute again; submitted sponsored swaps use the existing receipt-recovery path.
8. **Focused evidence — pass.** Seventeen Agent tests cover strict schemas, forbidden intents and fields, policy bounds, rolling limits, idempotent retries, credential hashing behavior, expiry, revocation before execution, wallet isolation, stale-transaction recovery, identity protection, fiat authentication denial, and pre-login/authenticated UI disclosures.
9. **Documentation — pass.** `README.md` documents the product surface, policy controls, human approval flow, request example, supported intent kinds, excluded powers, hash-only credential handling, and the current in-process/single-replica persistence boundary. No extra Markdown file was added.
10. **Repository and runtime verification — pass.** The final `npm run check` production build passed with 287 tests and 8 credential/mainnet-gated skips. `npm run release:audit` scanned 246 bundle files successfully. `npm audit --omit=dev --audit-level=high` exited successfully with only the three already documented low-severity MagicBlock transitive findings. RustSec loaded the current database and exited successfully with the repository's documented exceptions and 11 allowed warnings; registry yanked-package lookups timed out. Diff whitespace, tracked secret/artifact, and plaintext capability scans passed. A local production server returned health `ok`, identity-less Agent workspace access returned `401`, and a fiat intent returned `403 AGENT_ACTION_NOT_ALLOWED`. The existing live deployment returned health `ok` after its xStocks cache refresh.

### Acceptance-criteria result

All nine acceptance criteria pass. The same Privy wallet remains the sole signer; the AI agent can create policy-bounded trading proposals but cannot move funds by possessing its credential. Every value-changing Convert, xStocks, or Futures action reaches the existing exact transaction review and requires the authenticated user to approve it in Privy. Fiat funding and general wallet authority are absent from the capability surface and covered by negative tests.

## Completed plan: production MCP integration

**Status:** complete
**Date:** 2026-09-28
**Scope:** expose Flay's existing approval-gated agent capability through a production, framework-neutral Streamable HTTP MCP server that any conforming remote MCP client can discover and call without expanding the credential's authority

### Security model

MCP is a typed adapter over the existing agent service, not another execution authority. Every MCP request requires the same wallet-bound bearer capability before protocol initialization or tool discovery. Tools may read public Flay market catalogs and create only the four existing structured trading intents. The server never returns or accepts Privy identity tokens, transaction bytes, signatures, private keys, fiat actions, wallet transfers, arbitrary instructions, policy changes, approvals, or direct execution. Submitted proposals still appear in Flay's approval queue and require the authenticated user to review and sign in Privy.

### Implementation plan

1. Add pinned official Model Context Protocol TypeScript server and Node transport packages compatible with Node 22 and the repository's Zod version. Use Streamable HTTP, JSON responses, and a fresh stateless server/transport pair per request to prevent cross-client response leakage.
2. Mount a dedicated `/mcp` protocol endpoint before the JSON REST parser. Support required `POST`, `GET`, and `DELETE` behavior, bounded bodies, protocol-version negotiation, structured JSON-RPC errors, hardened response headers, and graceful handling of unsupported standalone streams in stateless mode.
3. Authenticate every MCP method, including `initialize` and `tools/list`, with the existing `Authorization: Bearer flay_agent_…` capability. Reuse constant-time credential validation, expiry, revocation, and per-capability rate limiting; never place the credential in URLs, logs, tool results, or server state.
4. Register a deliberately small tool catalog: `flay_get_tokens`, `flay_get_stocks`, `flay_get_futures_markets`, `flay_request_convert`, `flay_request_stock_trade`, `flay_request_futures_open`, and `flay_request_futures_manage`. Discovery tools use public read-only services. Proposal tools call the existing `AgentService.submit` policy engine and return request/approval status only.
5. Give every tool strict input schemas, bounded output, MCP annotations, clear units, and actionable errors. Mark discovery tools read-only; mark proposal tools destructive and non-idempotent at the protocol metadata level while requiring client-supplied idempotency keys for safe retries.
6. Publish safe MCP metadata and framework-neutral connection guidance without exposing credentials. Document the endpoint, Streamable HTTP transport, authorization header, official SDK example, protocol probe, and first-proposal flow.
7. Add protocol-level integration tests with the official MCP client transport. Cover initialization, authenticated tool discovery, public reads, proposal submission, policy denial, bad/missing/revoked credentials, unsupported methods, origin rejection, concurrency isolation, and proof that no forbidden tool or secret appears in the catalog/results.
8. Keep the REST capability API and all manual trading flows backward compatible. Run TypeScript, production build, full tests, release audit, dependency audit, tracked-secret/artifact scan, local MCP client smoke, and safe live regression checks.
9. Compare every plan item and acceptance criterion with the final repository, embed the completion audit below this plan, push the verified commit, deploy it to Railway, and verify standards-compatible MCP initialization and tool discovery on the live endpoint before declaring completion.

### Acceptance criteria

1. Any conforming MCP client can connect to `https://flay-production.up.railway.app/api/mcp` using Streamable HTTP and a bearer capability kept outside prompts and source literals.
2. Missing, malformed, expired, revoked, or wrong capability credentials cannot initialize a session or enumerate tools and receive bounded authentication errors without credential leakage.
3. The MCP catalog contains only the seven documented discovery/proposal tools; there is no fiat, send, export, signing, MagicBlock, approval, execution, arbitrary-transaction, or policy-mutation tool.
4. All proposal tools use `AgentService.submit`, enforce the same guardrails and idempotency as REST, return an awaiting-approval result, and cannot move funds without a later Privy identity plus wallet signature in Flay.
5. Streamable HTTP behavior is standards-compatible, safe under parallel clients, bounded against resource exhaustion, and does not share server or transport state across capabilities.
6. Tool schemas and responses clearly document atomic units, slippage basis points, leverage basis points, route choice, symbols, native IDs, request expiry, and the required human approval step.
7. The Agent UI, REST API, Convert, Stocks, Futures, Funds, wallet, MagicBlock, and existing gasless flows retain their prior behavior and pass the full repository suite.
8. README and `agent.md` accurately document setup, trust boundaries, limitations, test evidence, and deployment verification without adding another Markdown file.

### Completion rule

Do not declare MCP complete until an official MCP client successfully initializes against the release build, lists exactly the intended tools under capability authentication, submits a policy-bounded proposal that appears in the approval workflow, the deployed endpoint proves the same release and authentication boundary without disclosing a user-held capability, all forbidden authority remains absent, and the full plan-to-code audit passes.

## Production MCP integration audit

**Status:** complete
**Date:** 2026-09-28

### Plan-to-code comparison

1. **Pinned official SDK and isolated transport — pass.** `@modelcontextprotocol/server`, `@modelcontextprotocol/node`, and the test-only official client are pinned at `2.1.0`. `server/agent/mcp.ts` creates a fresh stateless MCP server and transport for each request, returns JSON responses, disables subscriptions and keep-alives, and caps request bodies at 48 KiB. A clean install with npm 10, the version used by the deployment image, passed after the lockfile was regenerated with its required nested Zod 3 peer entries.
2. **Dedicated protocol endpoint — pass.** The MCP handler is mounted at the acceptance criterion's public endpoint, `/api/mcp`, before Express's REST JSON parser. `POST`, `GET`, and `DELETE` reach the official Streamable HTTP handler; other methods return a bounded JSON-RPC `405` with the allowed methods. Unsupported stateless streams and session deletion fail cleanly without exposing internal state.
3. **Capability authentication and resource bounds — pass.** Every protocol request, including initialization and discovery, requires the existing bearer capability. Authentication reuses hash-only constant-time validation, wallet binding, expiry, and revocation. The MCP layer applies a capability-scoped limit of 120 requests per minute with at most 2,000 in-memory buckets, checks same-origin browser requests, rejects credentials in URLs, and returns `no-store`, hardened headers, and bounded structured errors. Neither credentials nor identity tokens enter logs or tool results.
4. **Seven-tool authority boundary — pass.** The catalog contains exactly `flay_get_tokens`, `flay_get_stocks`, `flay_get_futures_markets`, `flay_request_convert`, `flay_request_stock_trade`, `flay_request_futures_open`, and `flay_request_futures_manage`. Reads return bounded public provider data. Proposal tools delegate to `AgentService.submit`; there is no fiat, send, key export, signing, MagicBlock, approval, execution, arbitrary transaction, or policy-mutation tool.
5. **Strict schemas and human approval — pass.** The MCP tools reuse the Agent service's strict Solana-address, u64 amount, stock-symbol, stock-amount, and futures-market schemas. They reject unknown fields and invalid order semantics, document atomic and basis-point units, require UUID idempotency keys, expose route choice and provider-native IDs, and mark read/proposal behavior through MCP annotations. Successful proposals return their request status and expiry plus `fundsMoved: false` and `humanApprovalRequired: true`; only the authenticated user's later Privy review and signature can move funds.
6. **Framework-neutral product and documentation — pass.** The Agent credential dialog shows the Streamable HTTP endpoint and Authorization header without persisting the one-time credential. `README.md` documents generic MCP connection setup, an official TypeScript client example, the exact catalog, safe credential handling, the proposal workflow, and excluded authority. The architecture and wording apply to any conforming MCP client and add no framework-specific dependency.
7. **Official-client and negative evidence — pass.** `server/agent/mcp.test.ts` starts the actual HTTP API and uses the official `Client` plus `StreamableHTTPClientTransport` to initialize, list exactly seven tools, read token metadata, submit a futures-management proposal, and find that proposal in the user's approval workspace. Parallel clients with different product policies remain isolated. Tests also cover policy denial, missing, malformed, expired and revoked credentials, foreign origins, unsupported methods, standalone GET/DELETE behavior, oversized requests, forbidden tool names, and credential absence from catalogs and results.
8. **Regression, release, and security checks — pass.** A clean npm 10 install succeeded. `npm run check` completed TypeScript checking, the production Vite build, 49 passing test files, 290 passing tests, and 8 explicitly skipped credential/mainnet-gated tests. `npm run release:audit` scanned 246 bundle files successfully. `npm audit --omit=dev --audit-level=high` exited successfully with only the three previously documented low-severity MagicBlock transitive findings. The tracked artifact, plaintext credential, secret, and diff checks passed; the earlier RustSec audit remained successful with the repository's documented exceptions and allowed warnings.
9. **Deployment and live boundary — pass.** Commits `0b4ed07` and `323b77e` were pushed to `origin/main`. Railway deployment `39e3e05c-a828-4e01-9355-9c23c4c482ee` completed successfully. The live health endpoint returned `ok` and advertised `Model Context Protocol · Streamable HTTP · /api/mcp`; a live initialize request without a capability returned JSON-RPC `401 AGENT_CREDENTIAL_REQUIRED` with `WWW-Authenticate: Bearer realm="Flay MCP"`, a malformed capability returned `401 AGENT_CREDENTIAL_INVALID`, and a foreign Origin returned `403 ORIGIN_REJECTED`. Authenticated official-client discovery and proposal flow were proven against the same release build locally without copying a user-held capability into automation.

### Acceptance-criteria result

All eight acceptance criteria and all nine implementation items pass. Any standards-compatible remote MCP client can use Flay's Streamable HTTP endpoint with a user-created capability. That capability remains an in-process, single-replica, revocable proposal credential, so a deployment invalidates existing credentials and the user must create a new one. It can discover bounded public data and create guardrail-checked Convert, xStocks, and Futures proposals; it cannot approve, sign, submit, fund, transfer, export keys, mutate policy, or move funds. The user's Privy wallet remains the only transaction signer.

## Completed plan: Agent Convert route recovery

**Status:** complete
**Date:** 2026-09-28
**Scope:** make an approved Agent Convert proposal preserve Flay's aggregator behavior when the highest-output venue quotes successfully but cannot build an executable transaction

### Implementation plan

1. Move the server-safe automatic route fallback policy into a reusable helper with an explicit allowlist of venue-local availability/build errors. Never fall through after balance, ownership, signer, semantic-validation, simulation-safety, or transaction-integrity failures.
2. During Agent Convert review, try each ranked live Jupiter, Raydium, and Orca candidate once until one produces the exact validated transaction. Keep route order unchanged so Flay still selects the best executable route.
3. When every candidate has a recoverable venue failure, return one bounded retryable error, retain the proposal in the approval queue, and show the attempted venue reasons. A provider's non-retryable security or user-funding failure must still stop immediately.
4. Add focused tests for successful fallback, exhausted fallback, dangerous-error stopping, venue-attempt bounds, retryable request state, and unchanged single-route behavior.
5. Run the full build, tests, release and dependency audits; compare this plan with the code; deploy to Railway; and verify the live application remains healthy before marking the fix complete.

### Acceptance criteria

1. If Jupiter cannot build after quoting but Raydium or Orca can, Agent review opens the surviving route's exact transaction instead of failing the proposal.
2. Each quoted venue is attempted at most once in ranked order, and no fresh unreviewed economic intent is introduced.
3. Insufficient balance, wallet mismatch, invalid/unsafe provider transaction, and simulation-integrity failures never trigger fallback.
4. Exhausted provider availability failures leave the request pending and retryable with a bounded useful message.
5. Manual Convert, MCP submission, policy enforcement, approval, Privy signing, and all existing product tests remain unchanged and passing.

### Completion rule

Do not declare this fix complete until the screenshot's single-provider failure path is covered by a passing fallback test, all acceptance criteria pass, and the verified code is live.

## Agent Convert route recovery audit

**Status:** complete
**Date:** 2026-09-28

### Plan-to-code comparison

1. **Shared explicit fallback policy — pass.** `shared/market-routing.ts` now contains the single allowlist of venue-local availability and build failures used by manual Convert and server-side Agent review. Balance, wallet ownership, signer, unsafe transaction, semantic validation, and simulation-integrity errors are absent from the allowlist and stop review immediately.
2. **Ranked executable aggregation — pass.** `server/market-route-fallback.ts` tries each quoted provider at most once, preserves the provider ranking, caps attempts to Jupiter, Raydium, and Orca, and stops at the first exact transaction that passes the existing preparation, structure-validation, and simulation path. `AgentService` places the declared best quote first and sends all ranked candidates through this helper.
3. **Recoverable exhausted state — pass.** When every venue fails for an allowed provider reason, Flay returns retryable `AGENT_NO_EXECUTABLE_ROUTE` with a provider-labelled message bounded below 420 characters. `AgentStore.noteFailure` therefore keeps the request pending with its failure visible, allowing the user to retry review. Funding and transaction-integrity failures remain terminal for the review attempt and cannot fall through to another venue.
4. **Focused evidence — pass.** New server tests reproduce the screenshot's `Jupiter: Failed to get quotes` path and prove that Raydium is prepared next. They also cover all-provider exhaustion, pending retry state, duplicate-provider suppression, three-venue bounds, single-route behavior, insufficient-balance stopping, and unsafe-transaction stopping. Existing manual Convert fallback tests continue to use the same error policy.
5. **Full verification and production — pass.** TypeScript and the production build passed. The full suite passed 50 test files and 296 tests, with 8 credential/mainnet-gated skips. The release audit passed across 246 browser bundles; the production dependency audit passed its configured high-severity threshold with only the three previously documented low-severity MagicBlock transitive findings. Commit `b9df20d` was pushed to `origin/main`, and Railway deployment `43869351-1807-4c80-b9ae-14d01cbdf794` completed successfully. Live health returned `ok`; a live USDC-to-SOL quote returned Jupiter as the best route with Raydium and Orca alternatives, confirming the deployed market currently exercises the repaired candidate shape.

### Acceptance-criteria result

All five acceptance criteria pass. Agent Convert now means best executable route: a venue-local Jupiter construction failure advances to the next ranked Raydium or Orca quote, while user-funding and transaction-safety failures remain non-bypassable. MCP still creates proposals only, and the user's later Privy review and signature remain mandatory.

## Completed plan: Agent transaction reconciliation UI

**Status:** complete
**Date:** 2026-09-28
**Scope:** reconcile a confirmed Agent market transaction with Flay's shared wallet balances and Activity view immediately after Privy execution

### Implementation plan

1. Verify the reported signature independently through the configured Solana RPC and distinguish an onchain failure from stale client state before changing execution logic.
2. Have the Agent workspace notify the application shell after a successful execution, including the reviewed action and execution result, without exposing transaction bytes or changing signing authority.
3. Refresh confirmed wallet balances immediately and once after a short RPC-settlement delay. Record completed Agent Convert and xStocks market signatures in the existing bounded wallet Activity store so the standard onchain activity verifier can display them.
4. Keep Futures behavior scoped to its existing portfolio reconciliation while still refreshing wallet balances after collateral-changing actions.
5. Add focused tests for Agent activity classification and duplicate-safe recording, then run full repository, release, and dependency checks.
6. Compare the implementation with this plan, deploy the verified build, confirm production health, and embed the completion audit before declaring the UI issue complete.

### Acceptance criteria

1. A confirmed Agent Convert updates the shared wallet balances without requiring logout, hard refresh, or another manual transaction.
2. Its signature appears in Flay Activity and resolves through the existing authenticated onchain verifier.
3. The Agent success UI shows the provider, confirmation state, shortened signature, and Explorer link.
4. The callback runs only after the server accepts the execution; failed or cancelled Privy actions do not refresh or create activity records.
5. Agent authority, exact-transaction review, Privy signing, server receipt validation, and all existing product behavior remain unchanged.

### Completion rule

Do not declare this fix complete until the reported transaction is verified onchain, post-execution reconciliation is covered by tests, all checks pass, and the fix is live.

## Agent transaction reconciliation UI audit

**Status:** complete
**Date:** 2026-09-28

### Plan-to-code comparison

1. **Independent onchain diagnosis — pass.** The configured Solana RPC reports signature `F9fPzrDJFPVEHKprLza4dkeAw2ddQwL4Stw95FAJyxM34oJv2mWAAohKE8gLpYhRFr3KyrTpEmvwvt6kcWXzWNB` finalized at 2026-09-28 13:57:38 UTC with `err: null`. The wallet's USDC changed from 0.065131 to 0.005131 and its SOL changed from 0.001791042 to 0.002291338: exactly 0.060000 USDC spent and 0.000500296 SOL received. A distinct Jupiter fee payer paid the 10,089-lamport network fee. The swap succeeded; the stale shared balance display caused the apparent failure.
2. **Post-execution notification — pass.** `AgentPage` emits the accepted execution and its reviewed action only after the execution or sponsored-completion API resolves. Rejected, cancelled, signing-failed, or server-failed actions never call the reconciliation callback. The callback carries public result/review data only and does not alter the Privy signing boundary.
3. **Balance and Activity reconciliation — pass.** The app shell refreshes confirmed balances immediately and again after a 1.5-second settlement interval. Agent Convert and resolved xStocks market results are converted into the existing wallet-scoped Activity format, deduplicated by signature, capped at 50 entries, and later resolved through the existing authenticated onchain activity endpoint. Futures results do not enter the market Activity format and retain their existing portfolio reconciliation.
4. **Clear success evidence — pass.** The Agent success banner distinguishes `confirmed` from `submitted`, shows the provider and shortened signature, and retains the Solana Explorer link. Local reconciliation failure cannot replace an authoritative successful server response with a false transaction failure.
5. **Focused and complete checks — pass.** New tests cover Convert classification, resolved stock context, Futures exclusion, signature deduplication, and the 50-entry bound. TypeScript, the production build, 51 test files, and 299 tests passed, with 8 credential/mainnet-gated skips. The release audit passed across 246 browser bundles. The production dependency audit passed the configured high-severity threshold with only the three previously documented low-severity MagicBlock transitive findings.
6. **Production verification — pass.** Commit `5975d17` was pushed to `origin/main`; Railway deployment `0b7491ae-632e-4edd-85cf-121993ec6e10` completed successfully. Live health returned `ok`, and a post-deployment RPC check reconfirmed the reported signature as finalized with no error.

### Acceptance-criteria result

All five acceptance criteria and all six plan items pass. Confirmed Agent market transactions now refresh shared balances, enter Activity, and show their signature immediately while preserving the same exact-transaction review, server receipt checks, and user-controlled Privy signature.

## Active plan: User-selectable Agent approval mode

**Status:** repository implementation verified; production activation pending

**Scope:** let each Agent capability use either `Always ask`, where the user reviews and signs every request in Flay, or `Automatic within guardrails`, where a one-time Privy wallet delegation lets Flay execute the agent's supported trading intents without another UI visit

### Authority and safety model

The approval choice belongs to each capability and cannot be changed by the agent. `Always ask` preserves the current review queue. `Automatic within guardrails` is enabled only after the authenticated user completes Privy's one-time Solana wallet delegation and only while Flay's server-side Privy signer is configured. The bearer capability continues to submit structured Convert, xStocks, and Futures intents only. It never receives transaction bytes, a wallet signer, a Privy token, an authorization key, or a general RPC method.

Flay must apply the same product, asset, market, USD, rolling daily, slippage, leverage, position-count, expiry, route, transaction-structure, simulation, and receipt checks before automatic signing. Fiat funding, wallet send, private-key export, message signing, MagicBlock access, arbitrary instructions, arbitrary program calls, approval-mode changes, and policy mutation remain absent from both REST and MCP capability surfaces. Revoking a capability stops it immediately; the wallet owner can also revoke Privy's delegated wallet access from the Flay UI.

### Implementation blocks

1. Extend shared Agent contracts and strict schemas with an immutable `always-ask | automatic` approval mode, request execution mode, automatic-execution status, and truthful workspace security/readiness fields. Keep existing callers backward-compatible by defaulting omitted mode to `always-ask` at the schema boundary.
2. Add server configuration and a small Privy delegated-wallet signer adapter using `@privy-io/node`. It must require app ID, app secret, and a P-256 authorization private key; resolve the authenticated user's delegated Solana wallet ID from Privy; verify wallet ID, address, and chain before every signing action; and expose no raw signing endpoint.
3. Store the delegated wallet ID only in the private credential record. Never return it through workspace, REST, MCP, logs, audit detail, or the one-time credential response. Reject automatic credential creation unless server signing is configured and Privy reports the exact embedded Solana wallet as delegated.
4. Add a concurrency-safe automatic execution path to `AgentService.submit`. Reuse the existing risk checks, best-executable-route preparation, validated prepared transaction, provider execution, receipt verification, and completion record. Deduplicate simultaneous/idempotent retries so an intent can be executed at most once. Retryable provider failures remain visible and retryable without bypassing limits; terminal validation or authorization failures become failed requests.
5. Support both execution shapes: server-side `signTransaction` followed by Flay's existing Jupiter/Futures executor, and Privy server-side sponsored `signAndSendTransaction` followed by Flay's existing sponsored receipt verifier for eligible Raydium/Orca market routes. Never skip simulation or semantic validation.
6. Update REST and MCP results so `Always ask` clearly returns `humanApprovalRequired: true` and the UI review step, while automatic credentials return the actual completed, pending-retry, or failed state and transaction evidence. Do not claim funds moved unless Flay has an execution result.
7. Add the approval-mode selector, one-time delegation flow, readiness/error copy, credential mode badges, automatic activity/history states, and delegated-access revocation control to the responsive Agent workspace. Keep the manual exact-review modal unchanged for `Always ask`. Reconcile successful automatic market transactions into balances and Activity when the workspace observes completion.
8. Update health diagnostics and the root README with required environment variables, Privy Dashboard setup, one-time consent, mode behavior, revocation, MCP behavior, and the unchanged excluded authorities. Do not add another Markdown file.
9. Add focused tests for schema defaults/strictness, unavailable signing configuration, wallet-ID/address validation, secret non-disclosure, successful automatic normal and sponsored execution, simultaneous and idempotent replay safety, provider failure recovery, revocation during execution, MCP truthfulness, fiat/general-wallet denial, manual-mode regression, and Agent UI mode/revocation copy.
10. Run the complete build and test suite, release audit, high-severity production dependency audit, diff/secret/artifact checks, and a local production smoke test. Compare every implementation and acceptance item below against the final repository and append the evidence here before declaring completion.

### Acceptance criteria

1. A user can choose `Always ask` or `Automatic within guardrails` while creating a capability; the chosen mode is visible and immutable for that capability.
2. `Always ask` continues to require authenticated UI review and a user Privy signature for every value-changing request.
3. After one explicit Privy delegation, an automatic capability can execute a valid Convert, xStocks, Futures open, close, or cancel intent without the owner opening Flay again.
4. Automatic execution uses the same live aggregation, exact prepared transaction, structure validation, simulation, receipt verification, guardrails, rolling limits, and audit trail as manual execution.
5. A repeated or concurrent idempotency key cannot sign or submit twice, including while the first request is executing or after completion.
6. Automatic creation and execution fail closed when server signer configuration is absent, delegation is missing/revoked, the Privy wallet ID does not resolve to the credential wallet, or provider validation fails.
7. Revoking the capability immediately prevents new and retrying requests. The UI also provides a clear control to revoke Privy's wallet delegation and disables automatic capabilities before revocation is attempted.
8. REST and MCP report whether human approval is required and whether execution completed. They never expose transaction bytes, signed transactions, wallet IDs, Privy secrets, identity tokens, or authorization material.
9. Fiat onramp, arbitrary wallet sends, exports, message signing, MagicBlock, arbitrary program calls, policy mutation, and direct signer access remain unavailable to agent credentials and are covered by negative tests.
10. No existing Convert, xStocks, Futures, Funds, wallet, MagicBlock, gasless, `Always ask`, or MCP discovery behavior regresses, and all required repository checks pass.

Do not mark this block complete until all ten implementation items and all ten acceptance criteria are evidenced in a final plan-versus-code audit below this plan.

## User-selectable Agent approval mode audit

**Status:** repository and production signer configuration verified; owner delegation smoke pending
**Date:** 2026-10-07

### Plan-to-code comparison

1. **Contracts and schemas — pass.** Shared policy, credential, request, execution, and workspace contracts now carry immutable `always-ask | automatic` state. The strict Zod boundary defaults omitted modes to `always-ask`, accepts only the two declared values, and rejects hidden fields such as a fiat grant.
2. **Privy signer boundary — pass.** `server/agent/delegated-signer.ts` creates the Node client only when the app ID, app secret, and authorization private key are present. It resolves the authenticated user's delegated embedded Solana wallet and rechecks its ID, address, and chain before each sign or sponsored sign-and-send call. No public signing route was added.
3. **Private delegated identity — pass.** The Privy wallet ID exists only in the private credential record. Public credential creation, workspace state, REST/MCP results, and audit events omit it. Automatic credential creation fails when the server signer or exact wallet delegation is unavailable.
4. **Automatic controller — pass.** `AgentService.submit` reuses the existing risk calculation, allowlists, rolling value limits, best-executable Convert fallback, xStocks quote path, Futures aggregator, prepared transaction validation, provider execution, receipt verification, and completion audit. In-flight executions are coalesced, completed calls are replay-safe, retryable failures retain one request, and pending Futures opens reserve the position cap across concurrent capabilities.
5. **Both transaction shapes — pass.** Normal Jupiter, xStocks, and Futures actions use Privy server signing followed by the existing executor. Eligible reviewed Raydium/Orca transactions use Privy's atomic sponsored sign-and-send followed by the existing sponsored receipt verifier. The preparation services still perform their established semantic checks and simulations.
6. **Truthful REST and MCP results — pass.** Both surfaces return `humanApprovalRequired`, `fundsMoved`, the owner-selected mode, current state, failure, and execution evidence. `fundsMoved` becomes true only for a completed request with an execution result. MCP trade annotations now correctly describe idempotent, state-changing calls.
7. **Owner UI and revocation — pass.** Agent access presents `Always ask` and `Full access`, requests visible Privy delegation before automatic credential creation, labels each credential's immutable mode, keeps automatic results out of the manual queue, polls and reconciles completions, and revokes all active automatic Flay credentials before calling Privy's wallet-delegation revocation. Revocation stops new/retry calls; the README states that a transaction already submitted to Solana cannot be recalled.
8. **Diagnostics and documentation — pass.** Health exposes only a sanitized `privyAgentDelegation` readiness boolean. `.env.example`, Railway IaC preservation, `AGENTS.md`, and the root README document the settings, dashboard steps, authorization model, revocation behavior, MCP/REST results, in-process persistence boundary, and excluded powers.
9. **Focused security and behavior evidence — pass.** Tests cover schema default/strictness, unconfigured and undelegated failure, wallet/address/chain verification, wallet-ID secrecy, normal and sponsored Convert, xStocks, Futures open/close/cancel, retry recovery, simultaneous/replayed idempotency, revocation between signing and broadcast, in-flight position limits, truthful MCP states, fiat/general-wallet/policy/MagicBlock denial, missing raw-sign endpoint, manual mode, and UI/reconciliation copy.
10. **Repository, browser, and deployment checks — pass.** `npm run check` passed 52 test files and 322 tests, with 4 files and 8 credential/mainnet-gated tests skipped. The release audit passed across 246 browser bundles, including the two new server-secret names. The high-severity production dependency audit exited successfully with only the three documented low-severity MagicBlock transitive findings. The responsive browser audit passed without runtime exceptions or page-level horizontal overflow, `git diff --check` passed, and local production smoke checks returned the expected root, identity, MCP, and forbidden-intent responses. Commits `41d31a6` and `df7738d` were pushed to `origin/main`; Railway deployment `e619e3da-f07d-47c0-919d-25833314fe02` is online and its live health endpoint returns `status: ok` with the new Agent API label.

### Acceptance-criteria result

Criteria 2 and 4–10 have direct code, test, local production, and deployed-boundary evidence. The implementation paths for criteria 1 and 3 also pass focused tests: a configured user can select either immutable mode, and automatic Convert, xStocks, Futures open, close, and cancel complete without per-action UI approval after delegation.

Production signer configuration for criteria 1 and 3 is now active. On 2026-10-07, the Privy app secret passed a read-only API authentication probe, and Railway deployment `476f2811-415c-400b-b8e2-2201783eb59d` completed successfully with both server-only credentials and the QuickNode Solana mainnet RPC. Live health reports `status: ok`, `privyAgentDelegation: true`, an available blockhash, and a successful v0 simulation probe. No secret or wallet key is stored in this file, Git, or browser configuration. This block remains short of `complete` until the owner grants the one-time wallet delegation in Flay and one owner-authorized mainnet smoke transaction confirms the complete configured Privy boundary.

## QuickNode RPC budget stabilization plan

**Status:** complete
**Date:** 2026-10-07

### Incident

The production SOL-to-USDC Convert request returned Railway HTTP 502 while the service repeatedly restarted. Railway logs identified an orphaned Solana web3 rejection from QuickNode: HTTP 429 / JSON-RPC code `-32007`, stating that the endpoint's 15 requests-per-second limit had been reached.

### Implementation plan

1. Add a single FIFO limiter at the Solana web3 HTTP fetch boundary so every primary RPC HTTP request shares the same requests-per-second and concurrency budget, including calls issued inside one higher-level operation.
2. Keep the default budget below QuickNode's 15 requests-per-second ceiling, make it server-configurable, bound queue wait time, and apply the same protection independently to a configured fallback RPC.
3. Recognize QuickNode's documented 429 shape as a recoverable orphaned background RPC rejection so a provider throttle cannot terminate the Node process. Unknown unhandled failures must remain fatal.
4. Add focused tests for the limiter's FIFO rate window, concurrency cap, timeout behavior, and QuickNode rejection classification.
5. Document the server-only tuning variables, run the complete repository checks and release audit, deploy to Railway, and reproduce the screenshot's exact `0.0005 SOL -> USDC` request against production.

### Acceptance criteria

1. A burst cannot start more primary RPC HTTP requests than the configured one-second budget or exceed the configured concurrency cap.
2. Queue saturation fails with a bounded, retryable RPC error instead of waiting indefinitely.
3. A QuickNode `-32007` / request-limit background rejection is contained without weakening the fatal handling of unrelated failures.
4. The production health probe reports an available blockhash and successful v0 simulation through QuickNode.
5. The exact screenshot quote request returns HTTP 200 with at least one executable route, and repeated requests do not restart the service.

Do not mark this block complete until the deployed acceptance checks pass and a plan-versus-code audit is recorded below this plan.

### Plan-versus-code completion audit

1. **Shared RPC budget — pass.** `server/rpc-rate-limiter.ts` implements one FIFO, evenly spaced HTTP request queue per configured Solana connection. `server/rpc.ts` installs it as the web3 fetch boundary for both primary and fallback connections, so nested and parallel web3 operations share the same primary budget. Defaults are 8 requests/second and 4 concurrent requests, leaving capacity below QuickNode's 15/second starter ceiling.
2. **Bounded saturation — pass.** Queued work has a configurable 10-second default timeout and rejects with `RpcQueueTimeoutError`; existing `withRpcFallback` handling converts an exhausted primary/fallback path into the established retryable RPC response rather than leaving requests pending indefinitely.
3. **Process containment — pass.** `process-safety.ts` now identifies QuickNode HTTP 429 / JSON-RPC `-32007` request-limit failures as recoverable only when the rejection also carries RPC-specific evidence. The existing unknown-failure test still proves unrelated unhandled failures remain fatal.
4. **Tests and documentation — pass.** Focused tests cover FIFO spacing, concurrency, queue timeout, and the exact QuickNode rejection. `.env.example` and the root README document all three server-only tuning variables. `npm run check` passed 53 test files and 325 tests, with 4 files and 8 credential/mainnet-gated tests skipped; `npm run release:audit` and `git diff --check` also passed.
5. **Production reproduction — pass.** Railway deployment `d2aef202-ceae-4503-915b-2df5fa8a6316` was uploaded from commit `b7910ef` and became healthy. The exact screenshot request (`500000` lamports SOL to USDC at 50 bps) returned HTTP 200 with executable Jupiter, Raydium, and Orca routes. Five subsequent quote-plus-health rounds for `500000` through `540000` lamports each returned quote HTTP 200, three routes, and health HTTP 200. Railway remained online and its post-deployment HTTP logs contained no responses at or above 400 during the verification window.

All five implementation items and all five acceptance criteria are satisfied.

## Active plan: Agent capability creation recovery

**Status:** deployed; owner-wallet verification pending
**Date:** 2026-10-12

### Incident

On mobile production, creating a `Full access` Agent capability remains on `Creating secure capability` indefinitely and never reveals the one-time bearer credential. The server is healthy and its Privy lookup confirms the affected embedded Solana wallet is still not delegated, so credential creation never completes. The client currently waits without a deadline on Privy's modal-based delegation hook before it calls `POST /api/agent/credentials`.

### Implementation plan

1. Replace the modal-based Privy delegation hook with Privy's documented headless delegation hook because Flay already presents the owner-controlled consent and guardrail UI.
2. Represent delegation and credential creation as distinct UI states so the user can see which operation is running and cannot start a duplicate request.
3. Bound the browser delegation wait. If Privy completes server-side but its browser promise does not settle, continue to the authoritative credential endpoint; if delegation is still absent, return an actionable retry message instead of spinning forever.
4. Bound every server-side Privy user, wallet, signing, and sponsored-send call so provider degradation produces a retryable response rather than an indefinitely open Agent request.
5. Add focused tests for completed, rejected, and timed-out browser delegation plus server-side Privy timeouts. Preserve the strict server delegation check before issuing a credential.
6. Run the focused tests, full `npm run check`, release audit, and diff checks. Compare the final code against this plan, deploy the verified build, verify production health, and record the audit before declaring this block complete.

### Acceptance criteria

1. A successful Full access delegation proceeds to credential creation and displays the one-time capability.
2. A stalled Privy browser promise cannot leave Flay spinning indefinitely; the server gets one chance to verify completed delegation and otherwise the UI returns to a retryable error state.
3. Rejected or failed delegation never creates a credential.
4. The server still issues automatic credentials only after Privy reports the exact authenticated embedded Solana wallet as delegated.
5. Privy API stalls during credential verification or automatic execution terminate with bounded, retryable Agent errors.
6. Always ask capability creation and all existing Agent authority restrictions remain unchanged.

Do not mark this block complete until the deployed Full access creation path no longer spins indefinitely and the plan-versus-code audit is recorded below.

### Deployed verification status

The implementation is committed as `aefe1e5` and Railway deployment `f53b7326-8b85-4919-b50e-0b40d56f9f76` is live. The focused delegation and signer tests pass, the full production build passes with 54 test files and 329 tests, the release audit passes, and production health reports `status: ok` with `privyAgentDelegation: true`. The served browser bundle contains the new bounded `Authorizing Full access` flow, and the deployment's verification window contains no application errors or HTTP responses at or above 400. The affected Privy wallet was confirmed as not delegated before deployment, so the final acceptance check must be triggered by its owner in the browser; this block remains open until that retry returns the one-time capability or exposes a new bounded error.
