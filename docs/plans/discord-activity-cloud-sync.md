# Discord Activity + Cloudflare live sync

Status: Waves A-B integrated; Wave C (desktop core) is next  
Written: 2026-08-07  
Resume point: current `main` after this update (implementation tip: `1c03f2b`)

## 0. Implementation progress

- Wave A is integrated: `src/shared/cloudSync.ts` is the bounded protocol-v1 allowlist, desktop
  publish messages carry no revision, and the server alone assigns broadcast revisions.
- Wave B is integrated: `cloud/worker/**` implements the authenticated D1 + SQLite Durable Object
  relay, and `cloud/activity/**` implements the Discord Activity live view. The Worker suite runs
  in the real Cloudflare Vitest pool (16 tests); the Activity has 18 jsdom component/transport
  tests and a production Vite build.
- Cloudflare's current declarative Durable Object `exports` configuration is used instead of the
  legacy migration array. D1 still uses `cloud/migrations/0001_initial.sql`.
- Root CI installs the isolated `cloud/package-lock.json` and gates cloud typecheck, strict lint,
  both test runtimes, the Activity build, and Wrangler deployment dry-run.
- A real Chromium Activity + local Worker end-to-end pass remains Wave E work. No Cloudflare or
  Discord resources have been deployed, and no production secrets or physical IDs are committed.

## 1. Outcome

Add an opt-in Discord Activity that shows a live, social subset of EQ Legends Companion while
the existing Electron app continues to tail and interpret the EverQuest log locally.

The first release is deliberately a vertical slice, not desktop parity:

- pair one Discord account with one desktop installation;
- publish the active character, current encounter, compact DPS rows, leveling summary, recent
  kills, and recent loot;
- let authenticated viewers watch that state live inside Discord on desktop, web, or mobile;
- retain no raw log lines, chat, tells, combat-event stream, or local machine paths;
- stop publishing immediately when the user disables sync or revokes the paired device.

The Electron app remains required for collection. A Discord Activity is a sandboxed web app in
an iframe and cannot read the local EQ log, output files, map packs, overlays, or speech engine.

```text
EverQuest log
    -> Electron parser + world model (existing)
    -> explicit CloudSyncState allowlist
    -> authenticated WebSocket
    -> Cloudflare Worker / per-user Durable Object
    -> authenticated WebSocket
    -> Discord Activity React UI
```

## 2. Fixed design decisions

1. **Derived state only.** The cloud boundary accepts `CloudSyncState`, never `LogEvent`, raw
   lines, arbitrary module snapshots, or open-ended metadata.
2. **Desktop remains authoritative.** Cloudflare relays the desktop's derived view; it does not
   reinterpret EQ events.
3. **Server owns revisions.** A Durable Object assigns the broadcast revision. A reconnect gets
   a full snapshot, so clients never need to repair an unbounded delta history.
4. **One Durable Object per Discord user for MVP.** Channel/raid rooms are a later additive
   capability. This keeps authorization and deletion semantics obvious.
5. **D1 stores control-plane data only.** Discord identities, device hashes, pairing codes,
   revocation, and session metadata belong in D1. High-frequency combat frames do not.
6. **No history in MVP.** The latest state lives in Durable Object storage and expires. R2 or
   summarized D1 encounter rows can be added only after retention controls exist.
7. **Two transports, one renderer-facing seam.** Existing desktop views continue over Electron
   IPC. The Activity consumes the cloud transport. Do not teach browser code about Electron.
8. **Opt-in and closed by default.** No endpoint or credentials means disabled. E2E mode never
   reaches the network. A new install does not publish until the user pairs and enables it.

## 3. Wire contract

Create `src/shared/cloudSync.ts`, pure and dependency-free, so desktop, Worker, Activity, and
node tests validate the same format.

Protocol version 1 exposes only:

```ts
interface CloudSyncState {
  publishedAt: number
  character: {
    id: string
    name: string
    server: string
    level?: number
    classes: string[] // max 3
    zone?: string
  }
  combat: {
    inCombat: boolean
    target?: string
    startedAt?: number
    totalDamage: number
    dps: number
    rows: Array<{
      name: string
      total: number
      dps: number
      kind: 'self' | 'party' | 'pet' | 'other'
    }> // max 20
  }
  progression?: {
    level: number
    percent?: number
    xpPerHour: number
    etaMs?: number
  }
  recent: {
    kills: Array<{ name: string; ts: number }> // max 10
    loot: Array<{ item: string; ts: number; quantity?: number }> // max 10
  }
}
```

Desktop messages are `publish` and `ping`. Server messages are `ready`, `state`, `presence`,
and bounded `error`. Every message carries `version: 1`. Parsers accept `string | unknown`,
never throw, reject unknown versions/types, enforce finite non-negative numbers, cap payload
and list sizes, and copy only named keys into a fresh object.

Do not put access tokens in this protocol. Authentication belongs to HTTP/WebSocket setup.

### Integrated contract

The reviewed contract is now on `main` in `src/shared/cloudSync.ts`, with coverage in
`tests/cloudSync.test.mts`. List overflow is rejected at the wire boundary; producers select and
cap their bounded rows before serialization. Desktop `publish` carries no revision. Only server
`state` messages carry the Durable Object's monotonically increasing revision.

## 4. Cloudflare + Discord application

Recommended tree:

```text
cloud/
  worker/
    index.ts                 # route composition
    auth.ts                  # Discord code exchange + signed session cookie
    pairing.ts               # short-lived, one-use pairing codes
    deviceAuth.ts            # device token issue/revoke/hash
    SyncRoom.ts              # Durable Object + hibernating WebSockets
    validation.ts            # HTTP boundary helpers
  activity/
    index.html
    src/
      main.tsx
      App.tsx
      discord.ts             # Embedded App SDK bootstrap/authenticate
      api.ts                 # pairing + WebSocket client
      components/            # compact live dashboard
      styles.css
  migrations/
    0001_initial.sql
  wrangler.toml
  vite.config.ts
  tsconfig.json
```

If root lint/project-service integration becomes awkward, use a self-contained `cloud/package.json`
and make root scripts call its checks explicitly. Do not hide the tree from lint. The committed
lockfile must make clean-checkout builds deterministic.

### HTTP routes

```text
POST /api/oauth/token          Activity sends Discord authorization code
POST /api/pairing              Authenticated Activity creates one-use code
POST /api/devices/pair         Desktop exchanges code for device id + secret
POST /api/devices/session      Device secret -> short-lived WebSocket ticket
DELETE /api/devices/:id        Authenticated Discord user revokes device
POST /api/viewer/session       Activity cookie -> short-lived WebSocket ticket
GET  /api/sync                 WebSocket upgrade, ticket selects role + room
GET  /api/me                   Authenticated account and device status
```

Never place a long-lived device token in a WebSocket query. Exchange it over HTTPS for a
short-lived, single-purpose ticket; the WebSocket may carry only that ticket. Store device
secrets as salted hashes. Pairing codes expire in five minutes, are single use, and are rate
limited by IP/account/device attempt counters.

### D1 tables

- `account(discord_user_id PRIMARY KEY, created_at, last_seen_at)`
- `device(id PRIMARY KEY, discord_user_id, secret_hash, label, created_at, revoked_at)`
- `pairing(code_hash PRIMARY KEY, discord_user_id, expires_at, consumed_at)`
- optional `audit(id, discord_user_id, device_id, action, at)` with bounded retention

Add indexes for pairing expiry and account device lookup. Do not persist `CloudSyncState` in D1.

### Durable Object behavior

- Identify object by `discord_user_id` after server-side authentication.
- Accept `publisher` and `viewer` sockets with hibernation attachments containing only role,
  device/user id, and connection timestamp.
- Allow one active publisher per device; newest connection replaces stale duplicate.
- Parse every publisher frame through the shared contract.
- Apply a message-rate and byte-rate budget; close repeated offenders.
- Assign monotonically increasing broadcast revisions.
- Persist only latest validated state, revision, publisher presence, and expiry alarm.
- Send latest state immediately to a joining viewer.
- Broadcast `presence:false` when the publisher disconnects; retain the last state briefly but
  render it as stale/offline.
- Delete state after a short TTL (proposed: one hour offline).

### Discord Activity bootstrap

1. Instantiate `DiscordSDK` with the public client id.
2. Await `ready()`.
3. Request the smallest scope set, initially `identify` only.
4. Send the returned authorization code to the Worker; the Worker holds the Discord client
   secret and exchanges it.
5. Call `authenticate` with the returned access token.
6. Use a partitioned, secure, HTTP-only session cookie for Worker API calls.
7. Open the viewer WebSocket through the configured Discord URL mapping.

Do not trust user/channel information directly from the SDK as authorization. Verify identity
server-side. Configure `/` to the deployed Worker/Activity origin in Discord URL Mappings. The
Activity must render useful offline, pairing, waiting-for-desktop, live, stale, and incompatible
protocol states.

## 5. Desktop publisher

Recommended files:

```text
src/main/cloudSync/
  state.ts       # construct + sanitize CloudSyncState from existing model snapshots
  client.ts      # HTTPS pairing/session and WebSocket lifecycle
  publisher.ts   # throttle/coalesce/reconnect and presence lifecycle
  config.ts      # endpoint validation and build/runtime gating
src/main/ipc/cloudSync.ts
src/preload/cloudSync.ts
src/renderer/src/features/preferences/CloudSyncSettings.tsx
```

Small shared-hot-file edits will also be required in `src/shared/ipc.ts`, `src/main/ipc/index.ts`,
`src/preload/index.ts`, the preload declaration, store types/accessors, and the Preferences
section composition. Re-read each immediately before editing because they are frequent merge
surfaces.

### State construction

Read existing authoritative sources; do not duplicate combat math:

- `getActiveCharacter()` from `src/main/session.ts`;
- `characterModule.snapshot()` for level/zone;
- `comboModule.snapshot()` for current class labels if confidently available;
- `combat.snapshot(Date.now(), { maxSegments: 1 })` for current/head encounter;
- `progressionModule`, `levelingModule`, `killsModule`, and `lootModule` snapshots for the
  bounded overview fields.

Map existing combat entity/source kinds explicitly to the four public kinds. If attribution is
ambiguous, publish `other`; never infer a Discord identity from an EQ name.

Build one pure `buildCloudSyncState(inputs, now)` function with unit tests. Its output must pass
the shared validator before the network client can see it. Golden tests should prove that raw
recent event text, proc details, spell messages, paths, and arbitrary snapshot properties do not
survive.

### Publish triggers

- Coalesce combat activity to at most one publish every 500 ms.
- Publish after generic module flushes that affect exposed fields.
- Publish a full state on pairing, reconnect, character switch, and enable.
- Send a low-frequency heartbeat while connected.
- Send offline/close on disable and orderly app quit.
- Back off reconnects with jitter and a ceiling; reset after a stable connection.
- Never connect in E2E, before opt-in, with an empty endpoint, or after revocation/401.

Prefer a local observer seam in the registry/session composition over sending data through a
renderer window. Cloud sync belongs in main and must work with the window closed/minimized.

### Persisted settings

Proposed shape:

```ts
interface CloudSyncPrefs {
  enabled: boolean
  endpoint: string
  deviceId: string | null
  deviceSecret: string | null
  pairedDiscordName: string | null
}
```

Do not place the raw secret in renderer state or telemetry. Ideally store it with Electron
`safeStorage`; if unavailable, explicitly document the local-at-rest limitation and keep it out
of exports. The renderer receives only status plus masked identity. Determine whether adding the
optional key requires a schema bump under current store law; if the secret storage format changes,
it definitely requires a migration.

Preferences UI needs: endpoint status, one pairing-code field, Pair button, Enable switch,
connection state, last successful publish time, paired Discord identity, Revoke/Forget action,
and the exact public data allowlist. Pairing and publishing are separate actions.

## 6. Tests and verification

### Contract

- valid message round trips;
- malformed JSON and non-object input;
- unknown type/version;
- non-finite, negative, fractional-where-integer values;
- oversized payload, strings, and lists;
- extra/prototype-shaped keys do not survive;
- raw-log-like properties are omitted/rejected.

### Worker

- OAuth callback/code exchange failure handling;
- secure cookie attributes;
- pairing expiry, one-use consumption, collision retry, and rate limits;
- device secret hashing and revocation;
- ticket expiry and role isolation;
- unauthorized room access rejected;
- publisher validation, revision assignment, reconnect snapshot, viewer fan-out;
- hibernation re-construction from attachments/storage;
- offline and TTL deletion behavior.

Use Cloudflare's local test runtime (Vitest Workers pool or current supported equivalent), not
hand-authored mocks for Durable Object semantics.

### Desktop

- pure state builder fixtures;
- reconnect/backoff with injected clock/socket factory;
- disabled/E2E/empty-endpoint network gates;
- 401 revocation stops retries;
- character switch sends full replacement, never cross-character deltas;
- Preferences pairing and disable/revoke behavior.

### Activity

- component tests for all connection states;
- Playwright browser test with a local Worker;
- Discord SDK adapter mocked only at its boundary;
- layout at narrow mobile and desktop Activity sizes.

### Repository gates per wave

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
```

Also run the Cloudflare package's typecheck, unit tests, production Activity build, and local
Worker integration tests. A main/renderer change requires the existing Electron e2e suite.
Never point tests at the owner's live EQ log or a deployed Worker.

## 7. Wave plan and ownership

Follow the repository worktree/merge rules: every executor gets an isolated worktree branch,
disjoint ownership, full checks at its tip, then the integrator merges with `--no-ff` and verifies
merged main. Stage explicit file lists only.

### Wave A — shared contract

Owner: `src/shared/cloudSync.ts`, `tests/cloudSync.test.mts` only.

- Review/salvage the existing WIP.
- Settle server-owned revision semantics.
- Make contract tests and full root gates green.
- Merge first; every later wave rebases on this contract.

### Wave B — cloud runtime and Activity, parallel

Executor B1 owns Worker routes, Durable Object, D1 migration, Worker tests, and Wrangler config.

Executor B2 owns Activity React UI, Discord SDK adapter, styles, component tests, and Activity
build config.

Integrator owns shared build-script/package/tsconfig/eslint edits after both reports, avoiding a
package-lock collision between executors.

### Wave C — desktop core

Executor C1 owns pure state builder and its tests.

Executor C2 owns network client/publisher and its tests.

These branches consume the merged shared contract but do not touch store, IPC, preload, or UI.

### Wave D — desktop integration

One executor owns store + IPC + preload + Preferences integration because those edits form one
user-visible transaction and splitting shared hot files would create partial-build commits.

Integrator wires publisher lifecycle into composition/session/quit after re-reading current
main. Add an e2e assertion that sync is off and network-silent by default, plus pairing UI tests.

### Wave E — hardening and documentation

- threat-model review;
- protocol compatibility test between built desktop and built Worker;
- clean-machine deployment rehearsal;
- `README.md`, `SECURITY.md`, and privacy/retention documentation;
- Cloudflare deployment runbook and Discord Developer Portal checklist;
- release notes only after owner acceptance.

## 8. Deployment checklist

1. Create the Discord application/team and enable Activities.
2. Configure supported platforms and the default Entry Point command.
3. Add production and local redirect URLs.
4. Put `DISCORD_CLIENT_SECRET`, cookie signing keys, ticket signing keys, and device pepper in
   Wrangler secrets—never source, `.env` committed files, Vite variables, or Activity JS.
5. Create D1, apply migrations, and bind the Durable Object namespace.
6. Deploy Worker + Activity assets to a stable custom domain.
7. Map `/` to that domain in Discord Activity URL Mappings.
8. Verify OAuth through Discord's proxy and verify WebSocket reconnect on desktop/web/mobile.
9. Confirm HTTP cookies use `Secure; HttpOnly; SameSite=None; Partitioned` where required by the
   Discord iframe flow.
10. Exercise device revoke, account deletion, offline expiry, and secret rotation before inviting
    non-team users.

## 9. Not in MVP

- raw-log upload or cloud parsing;
- automatic raid aggregation across unrelated Discord accounts;
- public encounter leaderboards;
- cloud alert execution, speech, or desktop overlays;
- remote `/outputfile` or EQ command execution;
- hosted map packs before license review;
- complete desktop tab parity;
- permanent encounter history.

## 10. Resume commands

Start the next session from a clean `main` and proceed with Wave C. Re-read the authoritative
desktop snapshot shapes before briefing the state-builder and publisher branches:

```powershell
cd D:\projects\everquest-companion
git status --short
git worktree list
npm ci --prefix cloud
npm run typecheck
npm run lint
npm test
npm run test:cloud
npm run build:cloud
npm run deploy:cloud:dry
```

## 11. Primary platform references

- Discord Activities architecture:
  <https://docs.discord.com/developers/activities/how-activities-work>
- Discord Activity authentication tutorial:
  <https://docs.discord.com/developers/activities/building-an-activity>
- Discord Activity networking and URL mappings:
  <https://docs.discord.com/developers/activities/development-guides/networking>
- Cloudflare Durable Object WebSockets:
  <https://developers.cloudflare.com/durable-objects/best-practices/websockets/>
- Cloudflare D1 limits:
  <https://developers.cloudflare.com/d1/platform/limits/>
- Cloudflare React + Vite hosting:
  <https://developers.cloudflare.com/workers/framework-guides/web-apps/react/>
