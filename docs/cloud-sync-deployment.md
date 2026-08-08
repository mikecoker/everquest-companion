# Discord cloud-sync deployment and threat model

This is the operator runbook for the deployed companion service. Physical Cloudflare ids and
secrets remain outside source control. Exercise every release blocker below before widening use.

## Trust boundaries

```text
local EQ log -> trusted desktop model -> strict shared allowlist
             -> HTTPS/WSS internet boundary -> Worker control plane
             -> per-account Durable Object -> shared-room Durable Object
             -> authenticated room members in the Activity
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
| Cross-room or unauthenticated access           | Discord-authenticated membership, hashed 12-character invite, exact-origin mutations, signed room handoff checked at DO boundary | Rotate a leaked invite and test isolation through the deployed Discord proxy.                                                |
| Over-counted multiplayer damage                | Shared encounters sum only each publisher's self and owned-pet rows; observed party rows are excluded                     | Keep aggregation tests whenever combat rows change.                                                                             |
| Forged/oversized publisher frames             | Shared parser at the Worker boundary, close/error on invalid input, publisher frame rate limit                             | Configure Worker request/CPU limits and monitoring before public use.                                                           |
| Pair-code guessing/abuse                      | Hashed five-minute single-use codes, account and client-IP rate limits, collision retry, bounded expired-row cleanup       | Confirm the real proxy supplies a trustworthy client IP header.                                                                  |
| Revoked publisher remains live                | Ownership-checked D1 revoke plus awaited DO RPC; matching sockets close 4003; other devices stay live                      | Exercise multi-device revoke in production before invite.                                                                       |
| Stale state presented as live                 | Explicit online/offline messages, Activity stale state, one-hour offline alarm deletion                                    | Alarm behavior must be observed after deployment and after a DO restart.                                                        |
| Browser-session theft/CSRF                    | Signed 24-hour HttpOnly Secure partitioned cookie; configured exact-origin checks on every browser mutation; no permissive CORS | Set `ACTIVITY_ALLOWED_ORIGIN` to the final Discord proxy origin and verify it after URL mapping.                                |
| Unbounded identity/control-plane retention    | Five-minute bounded cleanup of transient rows; authenticated account erasure removes D1 ownership rows and room state       | Monitor cleanup volume and exercise erasure against production bindings before invite.                                          |
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

The Worker test suite uses Cloudflare's local runtime and the Activity component suite uses jsdom.
`npm run test:browser --prefix cloud` additionally launches one installed Chrome/Edge instance,
applies D1 migrations to disposable local storage, and drives the actual Activity against a local
Worker/Durable Object over HTTP and WebSockets. It covers pairing, live fan-out, bounded-field
omission, desktop/narrow layout, offline/reconnect, and user-facing revocation. Discord OAuth is
mocked only at its external HTTP/SDK boundary; the deployed Discord iframe/proxy still needs the
portal verification below.

## Cloudflare preparation

1. Create the production D1 database and Durable Object namespace in the intended account.
2. Replace only the placeholder binding ids in a production Wrangler configuration; do not commit
   account ids or secrets.
3. Set `DISCORD_CLIENT_ID` as non-secret configuration. Store `DISCORD_CLIENT_SECRET`,
   `COOKIE_SIGNING_KEY`, `TICKET_SIGNING_KEY`, and `DEVICE_PEPPER` with `wrangler secret put`.
   Generate each signing key/pepper independently with a cryptographically secure generator.
4. Set `ACTIVITY_COOKIE_DOMAIN` only when the final host requires it. An invalid value fails
   closed; an unnecessarily broad parent domain widens cookie scope.
   Set `ACTIVITY_ALLOWED_ORIGIN` to the exact Discord proxy origin; browser mutations fail with
   403 when it is configured and the `Origin` header is missing or different.
5. Apply all migrations in `cloud/migrations/` to production D1 in order. Migration 0002 adds
   shared rooms, memberships, and room-bound viewer tickets.
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

- Set the tested `ACTIVITY_ALLOWED_ORIGIN` control to the final Discord proxy origin.
- Repeat the real-browser suite through Discord's deployed iframe/proxy.
- Exercise secret rotation, device revoke, last-publisher offline, one-hour deletion, and a DO
  hibernation/restart.
- Review the final privacy copy and retention values with the owner.
- Obtain owner approval before creating resources, deploying, or publishing release notes.
