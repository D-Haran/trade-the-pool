# Solana wallet identity and authentication

## Identity boundary

`users.id` remains the durable application identity and the only authorization principal. A user
may own multiple `user_wallets` rows; a canonical Solana base58 address may belong to only one
user. Wallet addresses never replace user IDs in tournament, entry, order, ledger, leaderboard, or
WebSocket ownership checks.

`user_wallets` records a row ID, user foreign key, canonical address, `SOLANA` chain, the cluster
on which ownership was verified, primary status, verification time, and timestamps. Solana public
keys are identical across clusters, so address uniqueness is global rather than `(network,
address)` uniqueness. The first wallet is primary. A partial unique PostgreSQL index prevents two
primaries; wallet mutations take a per-user transaction advisory lock. Primary changes clear the
old primary before setting the new one. Unlinking a primary promotes the oldest remaining wallet
by `created_at, id`, and unlinking the last wallet is rejected.

## Challenge and session flow

Wallet login is:

```text
server challenge -> wallet signature -> server verification -> users.id resolution -> Redis session
```

`POST /v1/auth/wallet/challenge` accepts only a wallet address. The server validates and
canonicalizes it, generates a 256-bit opaque challenge ID and a separate 128-bit nonce, constructs
the complete Sign-In With Solana (SIWS) input, and stores the authoritative state in Redis at
`wallet-challenge:<opaque-id>` for `WALLET_CHALLENGE_TTL_SECONDS` (300 seconds by default). It also
sets a host-only HttpOnly `ttp_wallet_flow` cookie for the same short lifetime and stores only its
SHA-256 digest with the challenge. The client does not supply a nonce, time, purpose, domain, URI,
chain, cluster, or browser binding.

Verification uses Redis `GETDEL`, so one verification attempt atomically consumes the challenge.
This is deliberately stricter than consuming only successful proofs: an intercepted challenge or
an invalid-signature retry cannot later become another login. The server checks the HttpOnly browser
binding, purpose, configured
domain and URI, cluster/chain ID, request ID, address, authenticated user and session binding for
link challenges, expiry, and reconstructed message before verifying Ed25519 over the exact bytes.
It rejects altered bytes, non-canonical addresses, malformed base64, non-64-byte signatures,
unsupported metadata, expired state, and replay. Signature verification is local and makes no RPC
request.

On wallet-first login, an existing wallet resolves its linked `users.id`. An unlinked address
creates a user and its first primary wallet atomically, but only after successful signature
verification. PostgreSQL address uniqueness resolves concurrent first-login races to one user.
The API then rotates any presented session, writes a new opaque Redis session with the existing
absolute lifetime, sets the normal `ttp_session` cookie, and closes sockets bound to the old
session. Subsequent REST and WebSocket authorization uses that session—not repeated signatures.

## Exact signed message

The payload follows the Wallet Standard Sign-In With Solana text convention:

```text
<WALLET_AUTH_DOMAIN> wants you to sign in with your Solana account:
<canonical address>

Sign in to Trade the Pool. This proves wallet ownership only; it does not authorize a transaction or transfer funds.

URI: <WALLET_AUTH_ORIGIN>
Version: 1
Chain ID: solana:<mainnet|devnet|testnet|localnet>
Nonce: <server-generated 32 lowercase hex characters>
Issued At: <server ISO-8601 timestamp>
Expiration Time: <server ISO-8601 timestamp>
Request ID: <opaque challenge ID>
```

Link challenges use the same format with the statement “Link this wallet to your Trade the Pool
account…” and purpose `LINK`. Wallet Standard `solana:signIn` is preferred. Wallets without that
feature may use `solana:signMessage` over these exact UTF-8 bytes. Phantom, Solflare, Backpack, and
other compliant wallets are discovered through the shared registry; no vendor is hardcoded.

## Linking, unlinking, and UI state

Linking requires an already authenticated session. Both challenge creation and verification bind
to the server-resolved `users.id` and a SHA-256 digest of that exact session identifier. No link
request accepts `userId`. The signed address is rejected if another user already owns it. Listing,
unlinking, and primary changes scope every query to the session user.

The following actions are intentionally different:

- **Disconnect wallet UI** asks the browser wallet to clean up the frontend connection. It does not
  unlink the address or invalidate the server session.
- **Unlink wallet** removes one `user_wallets` credential after server authorization. It does not
  delete the user or any tournament/trading history.
- **Logout** invalidates the Redis session and its private sockets. It does not disconnect or
  unlink the browser wallet.

## Configuration and failure behavior

- `WALLET_AUTH_ENABLED` enables wallet routes without affecting development-login isolation.
- `SOLANA_CLUSTER` is `mainnet-beta`, `devnet`, `testnet`, or `localnet`; it maps to the SIWS
  Wallet Standard chain ID.
- `WALLET_AUTH_ORIGIN` is the exact application origin and must be CORS-allowlisted.
- `WALLET_AUTH_DOMAIN` must equal that origin's host.
- `WALLET_CHALLENGE_TTL_SECONDS` is constrained to 30–600 seconds.

Production requires HTTPS for the wallet origin. No RPC URL, RPC credential, private key, seed
phrase, or client-visible server secret is configured. If Redis cannot issue or atomically consume
a challenge, wallet authentication returns `503 WALLET_AUTHENTICATION_UNAVAILABLE`; there is no
stateless fallback. Existing sessions retain their documented Redis failure semantics.

Dedicated Redis limits cover challenge IPs and address hashes, verification IPs, link/user
operations, and repeated invalid signatures. Audit events record lifecycle, request/user IDs,
cluster, wallet row ID, and a truncated hash of the address. They do not record nonce values, raw
messages, signatures, session IDs, or cookies.

## Threat model and review

- **Nonce replay:** random server nonces plus atomic `GETDEL`, expiry, and request IDs.
- **Challenge fixation/substitution:** the server owns every SIWS field; proof address and exact
  signed bytes must equal stored state.
- **Cross-origin use:** the payload binds configured domain and URI; credentialed browser writes
  also retain CORS, SameSite, Fetch Metadata, and origin checks.
- **Wallet/user reassignment:** a global unique address index and transactional conflict handling.
- **Account takeover by linking:** login session, user ID, and exact session binding are checked
  server-side; client user IDs are rejected.
- **Session fixation:** successful login uses the existing session rotation service and disconnects
  the old identifier's sockets.
- **Primary races:** a partial unique index plus per-user PostgreSQL advisory transaction locks.
- **Secret exposure:** no test signer ships in the frontend, and logging omits proofs and session
  credentials.

## Next-phase boundary

Wallet identity does not read balances or produce addresses for payment. Before any deposit,
withdrawal, USDC/SOL accounting, transaction broadcasting, custody, escrow, payout, on-ramp, swap,
or mainnet money movement work, the product needs a separately reviewed ledger/custody model,
transaction authorization policy, RPC/provider architecture, confirmation/reorg handling,
compliance and operational controls, and dedicated invariant/integration tests. None is implied by
a linked wallet.
