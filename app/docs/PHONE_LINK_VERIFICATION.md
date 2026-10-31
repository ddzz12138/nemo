# Phone connection verification

These explicit checks use synthetic profiles, chat replies and temporary storage.
They do not invoke Hermes, read connected Gmail/calendar accounts, enable live
phone access or provision a public relay. The browser check contacts the configured
public Nostr discovery services, whose availability is an external dependency.

## Local regression

```powershell
npm run check
npm test
```

Focused fixtures in `test/phone-link.test.mjs` cover key and DTLS channel binding,
single-use pairing, profile isolation, revocation, mutation replay, protected
storage failures, the internal gateway capability and signed expiring relay grants.
`test/phone-export.test.mjs` verifies the static export inventory and module graph.

`test/phone-setup.test.mjs` adds offline checks for stable Pages addresses,
canonical invitation paths, paste without sign-out, storage errors, cancelling
discovery/ICE, aborted relay grants and preservation of host identity during an
explicit address update. Startup retains the selected address. These tests open
no real sockets or source integrations.

## Real browser, synthetic assistant

With the pinned Electron runtime installed and the local transport assets prepared:

```powershell
npm run phone:prepare
npm run phone:check
```

The checked-in harness uses isolated hidden Chromium renderers, a temporary static
export and a real Trystero/Werift connection into a synthetic family gateway. It
checks pairing, a chat reply, an event stream, reconnect, host restart, two-profile
history isolation, device revocation and explicit profile switching that removes
the previous local key. The Safari install instructions and separate Home Screen
storage/paste flow are **emulated**, not real iPhone verification.

The harness also simulates Pages' `.html` redirects, a restored cached page
and pasting an already-used invitation without signing out. These scenarios
passed in the 28 October synthetic browser run. This does not establish real
Safari, cellular or background-recovery outcomes.

Results and screenshots are written under `.work/phone-link-verification/direct`.
The harness has a three-minute deadline and stops its own fixture processes.
Node must be on PATH; `NEMO_TEST_NODE` can select a particular Node executable.

## Forced relay

Build the optional same-PC TURN fixture with Go 1.27+:

```powershell
go -C test/fixtures/phone-turn build -o ../../../.work/phone-turn-fixture.exe .
$env:NEMO_TEST_TURN_BIN = (Resolve-Path .work/phone-turn-fixture.exe).Path
npm run phone:check -- --relay
```

On macOS, use an executable path without `.exe` and set `NEMO_TEST_TURN_BIN` using
the shell's environment syntax. The fixture binds one private interface and
permits relay traffic only to that same PC. It receives a random shared secret
over stdin and exits after three minutes or stdin closure. It is never a public
relay. The test forces both peers to relay-only ICE, requires a selected relay
candidate pair and verifies chat plus streamed events using expiring TURN REST
credentials delivered through the encrypted discovery mailbox.

Results are under `.work/phone-link-verification/relay`. This validates the protocol
and fallback integration; it does not validate an offsite coturn deployment, TLS
port 443, Safari, NAT64, mobile carrier restrictions or infrastructure capacity.

## Deployment acceptance

Follow the real-phone rollout check in [PHONE_ACCESS_SETUP.md](PHONE_ACCESS_SETUP.md).
Use Wi-Fi off, Mobile Data on and the previous VPN off. Keep a record of the actual
selected route. A synthetic reply, timestamp or open discovery socket cannot be
reported as a real iPhone cellular success.
