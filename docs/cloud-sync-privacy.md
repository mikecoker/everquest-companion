# Discord cloud-sync privacy and retention

Discord cloud sync is off by default. Pairing a desktop and enabling publishing are separate
actions. With no configured endpoint, no paired device, or the switch off, the publisher does not
open an HTTP or WebSocket connection. The repository's E2E channel refuses pairing and disables
publishing even if an enabled profile is seeded.

## What is published

The desktop builds one bounded `CloudSyncState` and validates it before sending. Protocol v1 can
contain only:

- publication time;
- active character id, name, server, up to three class names, optional level and zone;
- current-combat flag, optional target/start time, total damage, DPS, and at most 20 compact actor
  rows (name, total, DPS, and self/party/pet/other kind);
- optional level/progress/ETA evidence;
- up to 10 recent kills and 10 recent loot rows.

The shared parser rejects oversized payloads, strings and lists, invalid numbers, unknown protocol
versions, and malformed objects. It constructs a fresh allowlisted object, so extra and
prototype-shaped properties do not cross the boundary.

The protocol has no field for raw log lines, chat, tells, guild/group messages, file paths,
machine/user names, settings exports, map data, inventory dumps, alert text, audio, or the
event-by-event combat stream. Cloudflare relays the validated snapshot; it does not receive the
source log or reinterpret EQ events.

## Identity and credentials

The service stores the Discord user id, username/display name, optional Discord avatar URL,
paired device id/label, and a salted+peppered hash of the device secret. The raw device secret is
returned once to the desktop. Locally it uses Electron `safeStorage` when the OS makes encryption
available; Preferences warns when it must fall back to plaintext storage. The secret is excluded
from renderer state, telemetry, logs, and profile exports.

Browser authentication uses a signed, `Secure`, `HttpOnly`, `SameSite=None`, `Partitioned`
24-hour cookie. WebSockets receive only a single-use 60-second ticket in the query string, never
the long-lived device secret. Pairing codes expire after five minutes and are single-use.

## Retention in the current implementation

| Data                                                      | Current lifetime                                                                                                                                   |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Latest derived snapshot in the per-account Durable Object | Deleted by alarm one hour after the last publisher goes offline. There is no encounter history.                                                    |
| Browser session cookie                                    | 24 hours in the browser; the server keeps no session row for it.                                                                                   |
| Pairing codes and WebSocket tickets                       | Unusable after five minutes / 60 seconds respectively, or immediately after first use. A five-minute scheduler removes expired hashed rows in bounded 100-row batches. |
| Rate-limit buckets                                        | Stop affecting requests after their reset time and are removed by the same bounded cleanup scheduler.                                             |
| Discord account and device rows                           | Kept until the user chooses **Delete cloud account**. Device revocation timestamps one device; account deletion removes all account-owned D1 rows and wipes its room. |

## Controls

- **Disable** stops this desktop's publisher immediately but keeps its pairing for later.
- **Forget this desktop** removes local credentials and stops publishing. It does not claim to
  erase or revoke the server row.
- **Revoke in the Activity** marks the selected server-side device revoked, closes only that
  device's live publisher with code 4003, broadcasts offline state when it was the last publisher,
  and refuses its future sessions.
- **Delete cloud account** requires an explicit second confirmation, removes every account-owned
  control-plane row, closes all room sockets with code 4004, and deletes the room alarm/storage.
  A deleted account cannot reuse a previously consumed WebSocket handoff.

No Cloudflare or Discord production resources are included in source control, and the committed
configuration contains only placeholder physical ids.
