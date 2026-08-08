# Discord cloud-sync deployment and threat model

This is an operator runbook, not evidence that a production service exists. The repository ships
placeholder Cloudflare ids and no secrets. Do not invite users until every release blocker below
has been exercised against the intended production account.

## Trust boundaries

```text
local EQ log -> trusted desktop model -> strict shared allowlist
             -> HTTPS/WSS internet boundary -> Worker control plane
             -> per-Discord-user Durable Object -> authenticated Activity viewer
```

The renderer is not trusted with the device secret. The Activity is not trusted to claim a Discord
identity: the Worker exchanges its authorization code with Discord and signs the resulting
session. The Worker is not trusted with raw gameplay input: it accepts only the shared derived
state contract. Durable Object room membership comes only from a signed handoff created after a
single-use D1 ticket is consumed.

## Threat review

| Threat                                        | Implemented control                                                                                                        | Residual / operator action                                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Accidental raw-log or arbitrary-object upload | Fresh allowlist parser, finite/integer checks, payload/string/list caps, no `LogEvent` transport                           | Keep protocol changes additive and review every new field as a privacy change.                                                  |
| Stolen desktop credential                     | Salted+peppered server hash; OS-backed local encryption when available; secret never enters renderer/exports/telemetry     | Plaintext fallback is explicitly possible. Revoke the device; rotate `DEVICE_PEPPER` only with a forced re-pair plan.           |
| Ticket replay or role swapping                | Random hashed ticket, 60-second expiry, atomic one-use consume, role/subject in signed DO handoff                          | Query strings can appear in infrastructure logs; disable query logging and keep access-log retention short.                     |
| Cross-account room access                     | Room id derived from verified Discord account; signed handoff checked at DO boundary                                       | Test through the deployed Discord proxy, not only direct origin.                                                                |
| Forged/oversized publisher frames             | Shared parser at the Worker boundary, close/error on invalid input, publisher frame rate limit                             | Configure Worker request/CPU limits and monitoring before public use.                                                           |
| Pair-code guessing/abuse                      | Hashed five-minute single-use codes, account and client-IP rate limits, collision retry                                    | Confirm the real proxy supplies a trustworthy client IP header; rate-limit storage currently needs cleanup.                     |
| Revoked publisher remains live                | Ownership-checked D1 revoke plus awaited DO RPC; matching sockets close 4003; other devices stay live                      | Exercise multi-device revoke in production before invite.                                                                       |
| Stale state presented as live                 | Explicit online/offline messages, Activity stale state, one-hour offline alarm deletion                                    | Alarm behavior must be observed after deployment and after a DO restart.                                                        |
| Browser-session theft/CSRF                    | Signed 24-hour HttpOnly Secure partitioned cookie; JSON/preflight on credential-changing device routes; no permissive CORS | Add an explicit allowed-origin/CSRF policy once the final Discord proxy origin is known. Treat this as a public-launch blocker. |
| Unbounded identity/control-plane retention    | Expired records are unusable and high-frequency state never enters D1                                                      | Periodic deletion of expired pairing/ticket/rate-limit rows and an account-erasure command are public-launch blockers.          |
| Secret/config disclosure                      | Wrangler secrets, no secrets in Activity Vite variables, placeholder ids committed                                         | Scan built assets and Wrangler output before every deploy.                                                                      |

## Local clean-machine rehearsal

From the repository root with Node 22+:

```powershell
npm ci
npm ci --prefix cloud
npm run typecheck
npm run lint
npm test
npm run test:cloud
npm run build:cloud
npm run deploy:cloud:dry
```

The Worker test suite uses Cloudflare's local runtime. The Activity suite uses jsdom. A real
Chromium Activity-to-local-Worker test is still required before public deployment; unit/component
coverage is not a substitute for Discord iframe, cookie, proxy, and WebSocket behavior.

## Cloudflare preparation

1. Create the production D1 database and Durable Object namespace in the intended account.
2. Replace only the placeholder binding ids in a production Wrangler configuration; do not commit
   account ids or secrets.
3. Set `DISCORD_CLIENT_ID` as non-secret configuration. Store `DISCORD_CLIENT_SECRET`,
   `COOKIE_SIGNING_KEY`, `TICKET_SIGNING_KEY`, and `DEVICE_PEPPER` with `wrangler secret put`.
   Generate each signing key/pepper independently with a cryptographically secure generator.
4. Set `ACTIVITY_COOKIE_DOMAIN` only when the final host requires it. An invalid value fails
   closed; an unnecessarily broad parent domain widens cookie scope.
5. Apply `cloud/migrations/0001_initial.sql` to the production D1 database before first traffic.
6. Build the Activity, run Wrangler dry-run, inspect the asset bundle for secret strings, then
   deploy from a reviewed commit.
7. Configure bounded Worker/access-log retention, alarms, and a cost ceiling.

## Discord Developer Portal checklist

1. Create/choose the Discord application and enable Activities.
2. Configure the Activity entry point and the exact OAuth redirect URL.
3. Map the Activity route to the deployed HTTPS Worker origin; use the same public client id the
   built Activity receives.
4. Verify OAuth, the partitioned session cookie, pairing, and viewer/publisher WebSockets from
   Discord desktop, browser, and a narrow mobile layout.
5. Verify waiting, live, stale, incompatible-version, revoked, reconnect, and offline states.

## Public-launch blockers

- Add the real Chromium Activity + local/deployed Worker end-to-end test.
- Implement and test D1 expiry cleanup and Discord-account erasure.
- Set and test an explicit Discord proxy origin/CSRF policy.
- Exercise secret rotation, device revoke, last-publisher offline, one-hour deletion, and a DO
  hibernation/restart.
- Review the final privacy copy and retention values with the owner.
- Obtain owner approval before creating resources, deploying, or publishing release notes.
