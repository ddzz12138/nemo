# Nemo desktop setup and phone access

Nemo's setup should let a parent name their profile, connect the assistant, sign
in, and scan a code. They should not install a VPN, configure a router or a
Cloudflare account, paste a tunnel token, or choose local executable paths.

This implementation provides the private setup controller, registration-service
client and supervised host connector. These components alone do not prove a
released installer or a live remote service works. An operator deployment,
verified packaged runtimes, clean-machine installation and a physical phone
check are still required. The setup reports unavailable components honestly.

## Private desktop controller

`createHostSetupServer()` in `lib/host-setup-server.mjs` opens an ephemeral HTTP
listener on `127.0.0.1`, separate from the application chat port. Its returned
`bootstrapUrl` contains a fresh capability in a fragment. The desktop main
process keeps that capability and sends it as a Bearer header; the local browser
fallback removes the fragment before making authenticated requests.

The controller serves only the setup assets and the following APIs:

| Method and path | Purpose |
| --- | --- |
| `GET /api/setup/status` | Profile, assistant, app and remote readiness |
| `POST /api/setup/owner` | Save the parent's name |
| `POST /api/setup/runtime/install` | Install the verified assistant runtime |
| `POST /api/setup/assistant` | Connect the assistant through the injected setup adapter |
| `POST /api/setup/enroll/start` | Begin owner sign-in; return the browser URL and confirmation code |
| `POST /api/setup/enroll/poll` | Check whether the parent approved sign-in |
| `POST /api/setup/remote/enable` | Provision and start the phone connection |
| `POST /api/setup/remote/disable` | Stop forwarding and confirm remote retirement |
| `POST /api/setup/invite` | Create a ten-minute profile invitation and QR image |

`/api/setup/enroll` and `/api/setup/runtime` are aliases for the corresponding
start/install actions. Mutating actions require JSON object bodies, an exact
local Origin and the setup Bearer capability. Every API requires the capability,
including status. All requests require the exact local Host, and cross-site
fetches are refused. Loopback source addresses and forwarded headers do not
identify desktop administrators.

The application tunnel **must never target this controller**. It targets only
the fixed application listener. The controller does not serve the phone pairing
page, private chat history, Hermes listeners or arbitrary local files. Responses
are non-cacheable, the page cannot be framed, and raw process/provider failures
are not returned to the renderer.

`runtimeStatus`, `appStatus`, `runtimeSetup`, `assistantSetup` and QR generation
are injectable. Phone pairing stays blocked until the assistant, application
and verified remote connection are all ready.

## Host connection lifecycle

`createRemoteHost()` in `lib/remote-host.mjs` exposes `beginEnrollment()`,
`pollEnrollment()`, `enable()`, `disable()`, `restore()`, `status()` and `close()`.
The host creates and protects its installation identity **before** sending a
registration request. Lost responses retry the same identity. A restarted host
reconciles the same installation and address rather than creating another one.

`remote-access.json` records only installation ID, desired on/off state, assigned
origin, tunnel ID and pending retirement. The installation secret, enrollment ID
and connector credential use `remote-access.dpapi`, backed by Windows DPAPI or
the existing macOS Keychain adapter. There is no plaintext fallback. Operator
Cloudflare credentials never belong on the desktop.

`createCloudflaredConnector()` requires an absolute binary path and a pinned
SHA-256 hash supplied by the verified release manifest. It does not search PATH
or invoke a shell. The per-installation token travels in the dedicated child's
transient `TUNNEL_TOKEN` environment, which cloudflared supports. It is absent
from command arguments, the parent environment, plaintext files and diagnostics;
child output is not logged. Source: [Cloudflare run parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/).

Starting a process or receiving a hostname does not mark Nemo ready. The caller
activates the exact public origin on the chat server, then verifies an HTTPS
identity challenge at that address. The verifier must return `true` only for the
expected installation and challenge, refuse redirects and apply a timeout.
Periodic checks detect loss of reachability. Process crashes immediately block
new pairing and trigger bounded restart attempts. Generation guards prevent a
late health response from resurrecting an exited or stopped connection.

Disabling first persists the off state and stops the local connector. It then
asks the service to retire the remote route and connector sessions. Network
failure leaves `retirementPending` visible; Nemo does not claim confirmed global
revocation. A confirmed retirement removes the cached connector credential while
preserving profile history and the installation identity for re-enabling its
stable address. Normal application shutdown stops the connector while retaining
the desired setting for the next launch.

## Registration service transport

`createRemoteCloudClient({origin})` in `lib/remote-host-cloud-client.mjs` requires
an operator-configured HTTPS origin without credentials, path or query. It uses
the `/v1/enrollments` and `/v1/installations/:id` contract, bounded response sizes,
timeouts and no redirects. Returned browser sign-in addresses must use that exact
registration origin. Secret credentials never appear in request URLs, and raw
service response errors are not passed through to the parent.

## Phone invitations

The private controller uses the existing profile store to issue one-use,
ten-minute invitations. Its QR URL has the form
`https://<assigned-host>/pair.html#invite=<code>`. The fragment keeps the code out
of HTTP requests and access logs. The phone pairing page removes it and submits
the code in a POST body after showing the intended profile and asking for
confirmation. The remote address is supplied by the verified host manager; the
desktop cannot choose an arbitrary URL to proxy or invite.

## Verification

`test/remote-host.test.mjs` covers response loss, identity reuse, process crashes,
restart limits, readiness, protected credential boundaries, uncertain retirement,
fixed transport and binary verification. `test/host-setup.test.mjs` exercises real
temporary loopback servers: missing capabilities, spoofed forwarding/Host,
cross-site origins, unsupported input, parent-name saving, real one-use invites
and readiness gates. All providers and connector processes in these tests are
synthetic; they do not create live Cloudflare or model-provider resources.
