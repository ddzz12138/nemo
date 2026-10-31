# Built-in phone connection

Implementation scope: Trystero/Nostr discovery, browser device keys, a typed authenticated channel into the existing family gateway, streaming, reconnect without mutation replay, opt-in owner setup, static-app export and optional TURN. No paid service, public endpoint or live deployment is enabled by default.

Identity decision: the QR pins the host's P-256 public key and supplies a high-entropy private discovery room. Mutual proofs bind actual Trystero peer IDs, fresh nonces and both peers' SHA-256 DTLS certificate fingerprints. The channel binding is rechecked before dispatch and every private response chunk, preventing copied room secrets/peer IDs from proxying a key proof onto another connection. The host binds a redeemed personal invitation to the browser public key and an existing Nemo device. The browser stores its non-extractable signing key in IndexedDB. The host stores its signing key and room secrets in the OS credential store; no plaintext fallback. Every dispatch rechecks the existing profile/device store.

Gateway decision: forward only validated Nemo API operations to the existing loopback family server, using a one-use dispatch capability minted inside the host process. Peers cannot supply cookies, profile headers, destinations, connector credentials or setup commands. Existing family permissions and Memory/Gmail scopes remain authoritative. Stream chunks require acknowledgements and have bounded buffers.

Recovery decision: never automatically replay mutations. Persist mutation receipts before dispatch and reject repeated or uncertain transport request IDs. Existing chat/native request IDs continue to provide domain-level reconciliation. Reconnect refreshes saved views and event cursors. Expired/revoked devices cannot reconnect.

Deployment gate: the stable static HTTPS frontend and any offsite TURN service require a reviewed deployment. The feature stays off until the owner configures it. Synthetic checks do not establish real iPhone cellular or locked-phone delivery.

## Verification on 27 October 2026

- Full synthetic suite: **476 passed, 12 skipped, zero failed** (488 total).
- Syntax: 120 application JavaScript files passed, plus the browser harness.
- Real Chromium-to-Werift direct connection through public Nostr discovery:
  exported UI pairing, synthetic chat, live event stream, reconnect, host restart,
  two-profile history isolation, revocation and explicit profile switching passed.
- Separate Safari/Home Screen storage and installation guidance passed in
  emulation. This does not establish Safari or iPhone cellular compatibility.
- Both peers forced through a same-PC TURN REST fixture: actual selected relay
  candidate, synthetic chat and event streaming passed. The phone obtained
  short-lived credentials through the encrypted, signed discovery mailbox.
- Static export inventory and runtime imports passed. Distribution includes
  the export scripts and optional relay template; no runtime data is included.

Repeatable commands and boundaries are in
[PHONE_LINK_VERIFICATION.md](PHONE_LINK_VERIFICATION.md). Test results are scoped
to this revision; they do not establish a public frontend deployment, offsite
relay availability, real account migration or phone notification delivery.
