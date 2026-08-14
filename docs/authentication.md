# Authentication and session boundary

## Session lifecycle

The alpha uses an opaque, cryptographically random 256-bit session identifier. The browser holds
it only in the `ttp_session` cookie; Redis stores `session:<opaque-id>` with the durable PostgreSQL
user ID, creation time, and absolute expiry. Redis contains no balances, entries, orders, P&L, or
other account state.

The free-alpha default is a fixed seven-day (`604800` second) absolute lifetime, configurable with
`SESSION_TTL_SECONDS`. There is no idle timeout and no sliding refresh. REST reads, writes,
navigation, reloads, and WebSocket traffic do not extend the session. Login always creates a new
identifier and invalidates any identifier already presented by that browser. Logout is idempotent:
it deletes the server-side session, clears the cookie with matching attributes, and closes every
WebSocket bound to that session. An expired payload is rejected even if a stale Redis key remains,
so an expired identifier cannot be revived.

The Redis TTL and cookie `Max-Age` are set to the same lifetime. The cookie is host-only (no
`Domain` attribute), `HttpOnly`, `SameSite=Lax`, `Path=/`, and high priority. It is always `Secure`
when `NODE_ENV=production` and intentionally not `Secure` for loopback HTTP development. Production
security is never relaxed based on proxy headers.

API process restarts do not invalidate sessions because no session authority is held in process.
Redis process restarts preserve sessions when Redis restores its data; local Compose enables AOF
with one-second fsync and uses a durable volume. A Redis flush, unrecoverable Redis data loss, or a
replacement instance without the old data intentionally invalidates all sessions. During a
temporary Redis outage, authenticated requests return `503 AUTHENTICATION_UNAVAILABLE`; they do
not return `401`, and the browser retains its last known session state for retry.

## REST and WebSocket consistency

`GET /v1/auth/me` is the authoritative browser session check. A successful response restores a
session after reload. Only `401 AUTHENTICATION_REQUIRED` transitions the frontend to signed out.
Network errors, offline state, API 5xx responses, and `AUTHENTICATION_UNAVAILABLE` render a retryable
connectivity state without clearing session-scoped cache data.

Private WebSocket subscriptions are authorized against the Redis session and PostgreSQL ownership
at subscription time. Authenticated sockets are also revalidated every 30 seconds, have an exact
absolute-expiry timer, and are closed immediately by logout or login rotation in the same API
process. API restart closes sockets naturally; clients reconnect, fetch REST snapshots, and
resubscribe. A WebSocket transport reconnect never changes REST authentication state. The frontend
forces a fresh handshake after login/logout so a socket opened before login cannot carry a stale
authentication snapshot, and true logout removes private `entry:*` subscriptions.

## Origins, cookies, and CSRF

Credentialed CORS accepts only the exact comma-separated origins in `CORS_ALLOWED_ORIGINS`.
Wildcard origins and malformed origins fail startup validation; production origins must use HTTPS.
The API reflects an allowed origin and credentials intentionally and never combines credentials
with `*`.

Cookie-authenticated state changes are protected in layers:

- `SameSite=Lax` prevents the session cookie from accompanying ordinary cross-site state-changing
  requests;
- every browser `POST`, `PUT`, `PATCH`, and `DELETE` is checked against the configured origin using
  `Origin`, with `Referer` as a fallback;
- `Sec-Fetch-Site: cross-site` is rejected even when an origin header is absent;
- WebSocket handshakes apply the same origin allowlist;
- CORS does not authorize an origin that CSRF validation rejects.

Requests with none of these browser headers remain available to non-browser test and operational
clients, which must provide cookies explicitly rather than receiving ambient browser credentials.
`HttpOnly` protects the identifier from JavaScript access; it is not treated as CSRF protection.

## Expected deployment topology

Local development uses one hostname consistently:

- frontend: `http://localhost:3000`
- API: `http://localhost:4000`
- WebSocket: `ws://localhost:4000/v1/realtime`

Using `localhost` for one side and `127.0.0.1` for the other creates different cookie sites and was
the cause of intermittent local cookie rejection. The Playwright topology intentionally uses
`127.0.0.1` for both sides and is therefore also same-site.

Production should preferably expose `/v1` and `/v1/realtime` through the frontend's HTTPS origin.
Sibling HTTPS app/API subdomains under the same registrable domain are also compatible with the
host-only API cookie and `SameSite=Lax`, provided the exact frontend origin is allowlisted. A
cross-site frontend/API deployment is intentionally unsupported by this cookie policy; supporting
one would require an explicit `SameSite=None; Secure` and stronger CSRF-token design.

`TRUST_PROXY=false` is the safe default. Enable it only when the API is unreachable except through
a trusted reverse proxy that overwrites forwarding headers; otherwise client IP rate limits could
be spoofed.

## Development identities and durable accounts

Seeded development users have stable PostgreSQL UUIDs, and repeat seeding updates those same rows.
Tournament entries, orders, fills, positions, ledger history, and results reference the PostgreSQL
user ID. Logout, cookie loss, Redis loss, API restart, browser refresh, and WebSocket reconnect do
not recreate or own account state; a later session for the same user sees the same durable records.

Development user selection is registered only when `DEV_AUTH_ENABLED=true` outside production.
Environment parsing rejects the production combination, and API construction independently fails
before route registration if it is attempted. Hiding the frontend selector is not a security
boundary.

Wallet authentication preserves this identity boundary:

```text
authenticated user (users.id) -> one or more linked wallets (user_wallets.user_id)
```

Solana signature login and authenticated wallet linking resolve to that PostgreSQL user ID, then
issue the same normal Redis session described above. The complete schema, SIWS message, replay
boundary, primary policy, UI semantics, threat model, and explicit no-money boundary are documented
in [`wallet-authentication.md`](wallet-authentication.md).

## Security logging

Authentication and sensitive operations use structured events containing request ID, user ID when
known, lifecycle event type, failure code/category, and timestamp. Logs do not include raw session
identifiers, cookies, request bodies, authorization headers, sensitive headers, wallet nonces, or
wallet signatures. Infrastructure errors are associated with request IDs without changing a connectivity
failure into an authentication failure.
