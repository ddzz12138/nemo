# Family-friendly implementation status

## Implemented in this revision

- Portable host configuration and private data locations, preserving legacy data.
- CLI setup, metadata-only doctor, start, authenticated managed stop, invitations
  and Google Web client import.
- Windows DPAPI preserved; macOS records encrypted with AES-GCM using a short
  per-record key protected by Keychain, with stdin-only key input.
  Real Keychain verification remains pending.
- Explicit adult/child classification; old members remain unclassified.
- Children start with chat only; individual owner grants reach HTTP, queued
  dispatch, exact Hermes tool proof and MCP execution. Revoking a grant cancels
  incompatible work and prevents an old tool process returning late source data.
- Passkeys use discoverable, user-verified WebAuthn credentials bound to the
  configured origin and authenticated profile. One-use challenges, counter
  checks, per-key revocation and invitation recovery preserve private identity.
- Visible read-only parental review includes main chat and saved native-preview
  replies, plus active personal Memory facts and their derived summary. Source
  caches are excluded; each successful view is audited for the child. The
  parent's assistant never receives the reviewed material. Adults are excluded.
- Profile-bound capabilities with connection and Memory metadata readiness.
- Tools and phone setup, plus a unified private Tasks page for main/native work,
  questions, checklists, safe Activity, stopping and explicit budget extensions.
  Native tasks remain distinct from general autonomous/background capabilities.
- Native chat preview with a private Hermes home/transcript store per person and
  fixed host-relayed Calendar, Gmail and Memory reads. The same saved Connections
  consent and child grants apply. No Google credentials enter native workers.
  Tool calls retain task identity and are rechecked before and after retrieval.
- Native replies trigger permitted local Memory learning and expose safe tool /
  post-reply activity. Consent changes interrupt old work and prevent resuming a
  provider session containing previously shared source results.
- Unified private History lists main and native chats, with local text search,
  native transcript projection, stable earlier-chat imports/backups, multiple
  conversations, rename, branch, undo and confirmed deletion. Deletion includes
  compression continuations and verifies files; lost outcomes remain fenced for
  reconciliation. Legacy chats with unknown source access are read-only.
- Native Hermes clarification cards and revisioned checklists, persisted with the
  originating task. Waiting releases the cloud slot and excludes human/capacity
  time from the active budget. Typed drafts survive polling; answers deduplicate,
  follow-up cards remain private, and stale/revoked/foreign answers fail closed.
  These two conversation tools do not grant external action or source access.
- Native tasks enforce ten active minutes and 64 reads, pause at the budget and
  require an authenticated explicit extension. No automatic resubmission occurs.
- Host-managed Memory searches, writes, indexing and local review share one GPU
  slot across profiles; queued foreground reads take precedence over learning.
- Host-only shared-provider adapter: credentials resolve inside a trusted helper
  and never enter profile workers. Revocable grants and task admission gate
  inference. Both Chat Completions and Responses are supported, with the selected
  host model only. Two concurrent synthetic native profile replies passed using
  the installed host provider.
- Durable native task journal, request deduplication, stopping, policy revision
  checks and recovery that pauses uncertain work. Phone reconnection performs
  reads only. Two cloud slots are shared with the legacy bridge.
- Authenticated live task notifications with a private bounded cursor journal.
  Chat/Tasks fetch current authorized state after changes, disconnects and gaps;
  reconnects cannot replay submissions or answers. Event records contain IDs and
  hashes only. Device revocation, deletion and server shutdown close or invalidate
  old subscriptions; polling remains available when streaming fails.
- Internal exact-action approvals, expiry/replay checks, uncertain-outcome
  reconciliation and parent/subagent budgets. These are tested building blocks;
  powerful tools and their approval interface are not enabled.
- Docker policy with private volumes, no network, read-only root, non-root user,
  resource limits and no host directories/devices/socket. Actual two-profile
  isolation and volume resume passed on Windows. The probe image contains no
  Hermes engine or computer tools.
- Portable GBrain initialization using configured paths; no model download.
- MIT notices, contribution/security/design docs, CI definitions and allowlisted
  release packaging with checksums and a source manifest.

## Required next steps

1. Keep the working main chat until native account reads and post-reply learning
   have real iPhone acceptance. Native reads are implemented; powerful action
   approvals remain separate and no send/write connector tools are enabled.
2. Build/pin complete Hermes worker images and verify private mounts, network/tool boundaries and
   host approval enforcement on Windows and macOS.
3. Complete upstream native event reconciliation and powerful action approvals.
   The phone update stream has bounded durable notification replay and read-only
   snapshot recovery. Native question cards
   and checklists are implemented and verified against the installed runtime;
   richer queue controls, steering, side questions and model settings remain.
4. Complete default-engine cutover after phone acceptance. Profile-scoped native
   History imports, mappings, deletion and rollback preservation are implemented;
   the main CLI remains separately writable and no automatic migration has run.
5. Add native session controls, file/artifact handling, research/browser/computer
   adapters, background agents/schedules, voice/media and extensions, following
   the approved six-stage plan. Definitions alone do not establish readiness.
6. Finish administrator Memory setup and optional Scalekit onboarding. Verify
   real Mac installation/Keychain, two-adult inference and iPhone flows.
7. Run clean CI and release review, then publish only the clean source/artifacts.

Synthetic checks do not need real Gmail/calendar reads or model inference.
Earlier phone confirmations do not verify new code. Main chat retains its
six-call / 90-second / two-minute limits. The native preview enforces a ten-minute
active budget and 64 scoped reads with explicit budget extensions. Subagent and
action approvals remain building blocks. The old CLI MCP child still performs
its own Memory work outside the host GPU pool. No production legacy
history migration has run. Physical iPhone preview confirmation remains pending.
Real iPhone passkey enrollment also remains pending; synthetic Chrome tests use
the real WebAuthn verifier and a virtual authenticator, not a personal passkey.

See `docs/FAMILY_ACCESS.md` for identity, child permissions and review behavior.
