# Built-in phone access

Nemo can introduce a phone and host through public Nostr discovery and carry
authenticated API requests over an encrypted WebRTC data channel. It is optional
and off by default. This phone interface does not require a VPN or a publicly
exposed PC server. Local HTTP remains available for the host's setup controls.

## Prepare the phone interface

From the source checkout:

```powershell
npm ci --ignore-scripts
npm run phone:export -- .work/phone-app
```

The export target must be a new directory. Serve its contents at the root of a
stable HTTPS origin using a static host. For example, a free static hosting plan
can provide an HTTPS subdomain without requiring a household domain purchase.
On Cloudflare Pages use the project's main address, such as
`https://my-nemo.pages.dev`, rather than an eight-character deployment-preview
address. Preview deployments are immutable and do not receive later UI updates.
If an enabled host still uses a preview address, its setup screen suggests the
stable address. Review it and select **Update phone app address**; this preserves
the host's keys and paired devices. Startup never changes the selected address.
Phones changing web origins need a fresh invitation because their private
browser keys cannot be transferred automatically.
The export includes `_headers` for hosts supporting that format; on another host,
apply equivalent CSP, no-referrer and MIME headers. Test `/phone-app.json` and all
module assets. Do not forward the host setup controller or raw Hermes ports.

The export contains UI code and licence notices only. No profile database,
credentials, logs, server source or live data is included. Publishing this static
interface is separate from publishing the full Nemo repository.

## Enable it on the host

1. Start this version of Nemo and sign into the family owner's profile locally.
2. Open **Profile & settings > Set up phone access** (`/phone-access.html`).
3. Enter the static phone app's exact HTTPS origin and save. Phone access cannot
   enable until its public readiness marker responds correctly.
4. Optionally configure a relay below. Choose **Enable phone access**.
5. Select the intended family member and create a personal invitation. It expires
   after ten minutes; checking the preview does not consume it.

Public discovery services have their own limits and availability. An open
discovery socket does not prove a phone is connected. Nemo shows established
device connections separately. The PC/box must remain awake and online.

The phone app address belongs to **Phone access** (`phone-link.json.appOrigin`).
It is separate from the HTTP gateway's `publicOrigin`. Do not set the latter to
the static Pages address or add broad allowed-host exceptions to make WebRTC
work: signed phone requests reach the existing authenticated gateway internally
over loopback.

The host normalizes immutable Pages preview addresses to the main project
address. An already-enabled installation moves only after the main address's
readiness check succeeds, preserving its host key, private rooms and devices.
Updating just the app address does not require disabling active phone access.
Existing phones on a different web origin need a fresh invitation on the main
address; browser signing keys cannot be silently transferred between origins.

## Pair an iPhone

Scan the personal QR in Safari. For the installed experience, copy the invitation,
use **Share > Add to Home Screen**, open the new Nemo icon and paste the invitation.
Confirm the displayed person before connecting. This installation-first flow
handles Safari and Home Screen storage separation.

Pasting a link does not sign out the current person. The pairing screen checks
the invitation and asks for an explicit profile switch when needed. Both
extensionless Pages routes and their `.html` forms are supported. Restoring a
cached Safari page reloads its current identity and connection before reuse.

**Use Safari for now** is also available. It pairs that browser, not every browser
or app on the phone. A new person must explicitly switch and authenticate with a
new invitation; old private views are cleared and the previous local phone key is
removed. Revoke old devices under Family & devices. If the old host was offline
during switching, its owner can remove the inactive device entry later.

## Real-phone rollout check

After reviewing the static deployment, pair a test profile first. On the iPhone,
turn **Wi-Fi off**, leave **Mobile Data on**, and turn **Tailscale/other VPN off**
for this check. Open the new static app address, not the previous private-host
address. Receive one real reply, then reopen the Home Screen app and check its
saved conversation and connection indicator. A LAN test or a reply over the old
VPN route does not establish this connection's cellular readiness.

Repeat on a second network. Test a revoked invitation/device and a second family
profile with deliberately different test facts. Verify the selected relay route
on a network requiring TURN before promising fallback coverage. iOS background
suspension and locked-phone notifications remain separate acceptance checks.

## Optional TURN fallback

Some networks cannot establish a direct route. Nemo supports TURN REST
credentials compatible with coturn: an operator configures public TURN URLs and a
shared secret on the host. The host protects that secret with Windows DPAPI or
macOS Keychain. Browser clients receive ten-minute HMAC credentials through an
encrypted, signed discovery control exchange, authenticated by their paired key
or their still-valid invitation. They never receive the shared secret.

Credential renewal reconnects the transport before expiry. Saved server tasks
continue. Mutations are not automatically resubmitted; existing task IDs and
event cursors reconcile results. Repeated/uncertain transport actions are rejected.

An operator example is in `deploy/phone-relay/coturn.conf.example`. Review it for
the chosen server/network and use valid certificates. It provisions nothing,
changes no firewall and is not a claim of a free publicly available relay.
Software is free; someone must supply relay infrastructure and bandwidth. Nemo
does not silently enable a metered provider. Use relay quotas and abuse controls.

## Current boundaries

- Basic chat, Activity/polling, native event streams, History, existing connected
  account reads and profile-scoped Memory use the existing authenticated gateway.
- Google account changes currently use the existing host/HTTPS OAuth onboarding.
  A separate static origin does not inherit its cookies or registered callback.
  The phone connection displays a host-setup action instead of opening a broken
  OAuth flow. Existing Gmail grants/search/sync controls remain profile-scoped.
- Existing Calendar Shortcuts retain their HTTPS upload route. Shortcuts cannot
  directly call a browser WebRTC data channel. Calendar remains outside Memory.
- Device-key pairing is used for this transport. Existing HTTP passkeys retain
  their origin; passkey registration is not forwarded through the channel.
- API request bodies are bounded to 32 KiB, individual streamed responses to
  16 MiB, and stream buffers to 64 KiB. These are resource protections, not monthly
  allowances. General attachment/download transport needs separate verification.
- The current supported protected host stores are Windows/macOS. Linux box
  credential storage and packaging remain a separate portability step.
- Real Safari/cellular, blocked-network combinations and locked-phone push need
  real-device acceptance. A local relay fixture does not establish offsite access.

The feature has not been enabled in the existing live installation merely by
building or testing it. Roll out only after the static frontend and relay policy
are reviewed and a real phone completes pairing and a reply.
