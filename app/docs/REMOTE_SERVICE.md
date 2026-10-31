# Nemo hosted registration service

This is the operator-run part of “install Nemo, sign in, scan, chat.” Parents do
not create Cloudflare accounts, choose a domain, copy tunnel tokens, or install a
VPN. The desktop opens a familiar Google sign-in page; the parent confirms the
computer and the matching six-digit code. Phone pairing remains a separate,
profile-specific invitation created by the Nemo host.

The service is implemented and tested with simulated cloud responses. It has not
been deployed or tested against live Google/Cloudflare accounts. Use a dedicated
development domain for the first real integration. A finished Windows installer,
bundled runtime, and physical-phone verification remain separate release work.

## Start the hosted service

Use Node 22 or newer. This service needs no additional npm dependencies. Run:

```sh
node remote-service.mjs
```

Configure these on the hosting service, through its protected environment or
secret manager. These are operator settings, never a parent's setup steps.

| Setting | Purpose |
| --- | --- |
| `NEMO_REMOTE_ORIGIN` | Exact public HTTPS origin of the registration service, such as `https://setup.example.com` |
| `NEMO_REMOTE_DATA_FILE` | Absolute path on persistent private disk, such as `/var/lib/nemo-remote/state.json` |
| `NEMO_REMOTE_GOOGLE_CLIENT_ID` | Google web OAuth client ID |
| `NEMO_REMOTE_GOOGLE_CLIENT_SECRET` | Google OAuth client secret; hosted service only |
| `NEMO_REMOTE_CF_ACCOUNT_ID` | Cloudflare account owning the managed tunnels |
| `NEMO_REMOTE_CF_ZONE_ID` | Cloudflare zone owning the published installation addresses |
| `NEMO_REMOTE_CF_API_TOKEN` | Scoped operator API token; hosted service only |
| `NEMO_REMOTE_DOMAIN` | Owned zone domain, for example `example.com`; use a zone root so each opaque host is one label below it |
| `NEMO_REMOTE_ALLOWED_EMAILS` | Comma-separated, verified Google account emails invited to the pilot |
| `NEMO_REMOTE_PUBLIC_SIGNUP` | Optional explicit `1` to allow other verified Google identities; keep unset for the pilot |
| `NEMO_REMOTE_BIND` | Optional listener address, default `127.0.0.1` |
| `NEMO_REMOTE_PORT` | Optional listener port, default `8790` |

Register this exact redirect URI in the Google web OAuth client:

```text
https://<registration-service-host>/auth/google/callback
```

Give the Cloudflare token only the intended account's Tunnel Edit and intended
zone's DNS Edit permissions. The service reserves random names such as
`host-<32 hex digits>.example.com`. It configures one exact host to reach
`http://127.0.0.1:8787`, then a catch-all 404 rule. Desktop clients cannot choose
the domain, hostname, origin address, or arbitrary Cloudflare API operations.
Cloudflare's documented control-plane operations provide the named tunnel,
configuration and proxied DNS route. [Cloudflare API setup](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/)

Host behind an HTTPS reverse proxy. Restrict plain HTTP access to the private
listener; expose only the HTTPS registration origin. The service does not trust
`Forwarded`, `X-Forwarded-For`, or similar headers. When all requests arrive from
one reverse-proxy IP, its conservative service-wide IP limit also applies to all
those requests; enforce per-client abuse limits at the edge before enabling broad
signup. Choose hosting that preserves the database across deploys and restarts.

Run exactly one process for one database. The entry point acquires an exclusive
lock file before listening. After a crash, verify that the old process is stopped
before removing the stale `.lock` file. Do not use clustered workers, multiple
containers sharing the JSON file, or an ephemeral filesystem. A shared database
with transactional locking is required before scaling beyond one instance.

A minimal container recipe is `deploy/remote-service.Dockerfile`; the configuration
checklist is `deploy/remote-service.env.example`. Build it from the repository root
with `docker build -f deploy/remote-service.Dockerfile -t nemo-remote .`. It copies
only the service and its four dependency-free modules and runs as the unprivileged
Node user; no npm install or desktop assets are needed. Mount a persistent volume
at `/var/lib/nemo-remote`, inject the operator settings through the host's secret
manager, and publish port 8790 only to your HTTPS proxy. No image has been built or
deployed as part of this local implementation. Verify Docker availability,
volume ownership, proxy TLS, clean shutdown, backups and stale-lock recovery in
the chosen hosting environment.

Protect the data directory with service-account ACLs and encrypted storage and
backups. Unix file creation uses mode 0600 and directory creation 0700; Windows
operators must enforce equivalent ACLs. The file contains hashed installation
credentials, account identifiers, reserved hostnames, transient OAuth PKCE
verifiers, enrollment links, and hashed browser sessions. It contains no chats,
model credentials, Cloudflare account token, or saved connector tokens.

Disable request/body/header logging at the proxy and monitoring layers. In
particular, do not log OAuth callback query strings, enrollment URLs, cookies,
authorization headers, or API bodies. Application error logging contains only a
safe error code and HTTP status. Private responses disable caching and browser
setup pages set a no-referrer policy.

## Desktop contract

All API responses are JSON. Send `Content-Type: application/json` on every POST.
Errors use `{ "error": { "code": "...", "message": "parent-readable text" } }`.
No endpoint accepts an origin override or Cloudflare account credential.

1. On the computer, create a random UUID and a cryptographically random
   32-byte base64url installation secret. Save the secret in the OS secret store
   before making the first request. The ID and credential remain the same across
   timeouts, app restarts, remote-access disable/enable, and updates.
2. `POST /v1/enrollments` with
   `{ "installationId": "<uuid>", "installationSecret": "<secret>", "displayName": "Family computer" }`.
   The response contains `enrollmentId`, `installationId`, `status`, `browserUrl`,
   `confirmationCode`, `expiresAt`, and `pollAfterMs: 3000`.
3. Show the six-digit `confirmationCode` alongside “Finish sign-in in your
   browser.” Open `browserUrl` in the default browser. It never contains the
   installation credential. Google sign-in uses the authorization-code flow,
   PKCE, a browser-bound single-use state, and a nonce. The real identity adapter
   checks the signed token using Google's keys, issuer, audience, presenter,
   expiration and nonce. The parent then clicks **Connect this computer** on a
   page showing the same code and computer name. A verified account can approve
   only that pending enrollment. [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
4. Poll `POST /v1/enrollments/<enrollmentId>/poll` with body `{}` and
   `Authorization: Bearer <installationSecret>`. A successful response has
   `status: "pending"` or `"approved"`. Poll no more frequently than the given
   interval. Pending sign-in expires after 15 minutes. Begin enrollment again
   with the same identity to get a fresh link after expiry; never silently create
   another installation on a retry.
   `enrollmentId` is a UUID. A repeated begin request after browser approval
   returns `status: "approved"` and `browserUrl: null`; recover the signed-in state
   directly without opening a blank browser. An expired poll returns HTTP 410
   with `error.code: "enrollment_expired"`, so offer a fresh sign-in link.
5. Once approved, `POST /v1/installations/<installationId>/enable` with body `{}`
   and the same bearer credential. The successful response is:

   ```json
   {
     "installationId": "<uuid>",
     "status": "active",
     "publicOrigin": "https://host-<random>.example.com",
     "tunnelId": "<cloudflare tunnel uuid>",
     "connectorToken": "<only this installation's connector credential>",
     "updatedAt": "<ISO timestamp>"
   }
   ```

6. Protect the connector token in the OS secret store, start the verified bundled
   `cloudflared`, and verify the exact public host and Nemo installation identity.
   `active` means cloud resources exist; it does **not** mean the computer or app
   is reachable. Show the phone invitation QR only after application readiness.

Other installation endpoints require the same installation-specific bearer:

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/installations/<id>` | Safe status; never returns a credential |
| `POST /v1/installations/<id>/credentials`, `{}` | Re-fetch this installation's connector token, only while active |
| `POST /v1/installations/<id>/retire`, `{}` | Remove the remote route and tunnel; preserve local chats |

`GET /health` returns only `{ "service": "nemo-remote", "status": "ok" }`.
It is process health and not a real-cloud/readiness probe.

The status enum is `reserved`, `provisioning`, `active`, `error`, `retiring`, or
`retired`. Safe status may include a parent-readable `error`. Browser sign-in
does not automatically grant access to any Nemo profile, conversation, or tool.

## Recovery and turning access off

Owner identity is the verified Google subject identifier; an email change cannot
transfer ownership. Each installation's immutable identity and credential hash
are saved before provisioning. A different owner or credential cannot claim it.
Credentials and hostnames are never reassigned to another installation.

Provisioning records save the operation identity, owner, attempts and progress
before cloud mutations. The Cloudflare adapter looks up the exact reserved tunnel
name and DNS host on retries. This recovers both “created but response was lost”
and “created but process stopped before saving the ID.” Unexpected pre-existing
DNS records are not overwritten. Requests for one installation serialize, so
simultaneous enable/retry/retire operations cannot race each other.

Turning access off stops the local connector first. The hosted retirement then
sets deny-all ingress, removes the exact DNS route, disconnects connectors, and
deletes the tunnel. Removing connector connections is a separate operation;
rotating a token alone does not terminate existing connections. [Cloudflare connector removal](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/connections/methods/delete/), [Cloudflare token lifecycle](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/)

Any failure leaves status `retiring` with progress saved. The desktop must retain
its credential and keep the uncertainty visible until a later retry confirms
`retired`. Enabling again is refused during incomplete retirement. A completed
retirement can be enabled again with the **same** installation credential and
stable public address, using a fresh tunnel and connector credential. Repeated
retire calls are safe. Repeated active enable calls return the existing token.

The pilot caps each owner at three non-retired computers, ten new computer
identities per day and ten new enable operations per day, with global capacity
and anonymous enrollment/sign-in request limits. Operator deployment must add
edge abuse protection and monitor Cloudflare quotas before public signup.
The service also caps live pending enrollment links at 1,000 and total reserved
enrollment identities at 10,000 to bound anonymous storage growth. Capacity errors
need operator review; do not repeatedly create new desktop identities to retry.

Lost installation credentials, account deletion and cross-computer recovery are
not automated in this first service. Keep ownership records and backups; do not
delete the database to get around a conflict. An operator must retire an old
installation before an explicitly new installation takes its place. Parent-facing
recovery needs a separate authenticated design before a general release.

## Verification

Run `node --test test/remote-cloud.test.mjs`. These tests use generated RSA keys,
loopback HTTP, temporary persistent state and an in-memory Cloudflare control
plane. They do not contact Google or mutate a Cloudflare account. They cover
cross-owner credential/approval replay, OAuth state binding, signed identity
claims, a lost tunnel/DNS response, restart recovery, simultaneous retries,
foreign DNS conflicts, incomplete retirement, stable-host reconnection, quotas,
HTTP-origin restrictions, and secrets excluded from public status/storage/logs.

Before shipping, complete one real Google login, live named-tunnel provisioning,
stream/reconnect checks over phone mobile data with the VPN off, host restart and
disable/re-enable on the actual deployment. Also complete the local ingress,
installer/runtime, per-profile phone pairing and clean-machine acceptance checks
in the release installation-pilot checklist.
