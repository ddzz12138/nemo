# Changelog

## 0.3.0-alpha.14 — 2026-10-31

- Keep the desktop personal-session partition stable across updates. Explicitly persist login and logout cookies, and drain pending cookie writes during normal shutdown without changing session expiry.
- Treat temporary session lookup failures as retryable errors, preserving sign-in instead of repeating onboarding or creating another profile invitation.
- Verify a Windows version-folder upgrade retains login, saved chat and unchanged protected ChatGPT/Gmail records. Confirm expired or revoked sessions remain gated while completed setup and data are retained.

## 0.3.0-alpha.13 — 2026-10-31

- Replace desktop Chat with New Chat. Save the previous conversation and let users reopen and continue chats from Your conversations.
- Persist active and archived conversations in one atomic profile snapshot, importing legacy history once without modifying its backup. Preserve drafts per person and chat.
- Reset provider context when changing chats, preserve safe request replay, and reject stale tabs, cross-profile IDs and switches during an active reply.

- Restore the saved desktop profile directly to chat on cold startup, without flashing setup. Check the session after the first local page load so Electron includes its saved SameSite cookie.
- Offer a one-time personal confirmation for previously configured browser-based installations, while preserving first-run setup, plan acknowledgement, explicit sign-out and device revocation.
- Remember completed setup independently of ChatGPT connection status, including older installations with paired devices. Keep saved chat accessible while the account needs reconnecting.
- Keep returning users in the desktop application, with a one-time desktop profile confirmation when upgrading from the older browser-based launcher.
- Normalize Windows runtime-directory aliases only after verifying their physical filesystem identity, retaining all bundled-file and hash checks.

## 0.3.0-alpha.12 — 2026-10-31

- Connect Gmail directly from the desktop Settings screen with system-browser Google sign-in, S256 PKCE and a temporary local callback. Remove the unused desktop browser-invitation handoff.
- Include only the publisher’s public Desktop client ID; family members no longer need Google Cloud configuration or phone Web OAuth setup. Preserve existing operator clients and protected account records.
- Bind pending authorization to its initiating profile and device. Cancel on logout, revocation, disable, disconnect or timeout, including after Google has begun replying. Roll back interrupted account changes.
- Show waiting, cancellation, retry and connected states in Settings. Preserve on-demand email access and the person’s saved tool permission.
- Keep the existing phone OAuth path, with a consistent lock order and guarded account commit shared with desktop operations.

## 0.3.0-alpha.11 — 2026-10-30

- Replace the separate desktop wizard with the Ollama-derived layout throughout first launch, chat, Family, Memory and Settings in one Windows app window.
- Prepare the included assistant after naming the home owner; connect ChatGPT and confirm its plan usage before opening the personal profile. Phone and Gmail setup remain optional.
- Reuse existing private profile, invitation, device, calendar, Memory and provider APIs; include self-renaming and recorded, read-only child review inside the new Family screen.
- Keep the private setup capability in main. Personal home-management requests require the exact desktop document, current authenticated owner and displayed profile ID.
- Restore signed-out owner setup through the native Settings menu, preserve same-window menu/invitation navigation, and handle successful sign-out without losing the next invitation.
- Remove the unused host wizard HTML/JavaScript/CSS and separate chat preload. Retain phone screens and provisioning services still in use.

## 0.3.0-alpha.10 — 2026-10-30

- Add the Ollama-derived desktop conversation layout, private main-chat history and connection settings inside a separate sandboxed Nemo window.
- Keep ChatGPT connection management in private setup; retain backend profile checks, authoritative tool permissions and safe retries.
- Format assistant paragraphs, lists, emphasis and code as text-only React elements; model output cannot inject HTML or executable links.
- Make Gmail optional in Settings and isolate its readiness errors from normal chat. Public Google configuration is deferred.
- Improve narrow-window navigation with Escape dismissal, focus restoration and an inert background while the sidebar is open.
- Include upstream notices and locally compiled frontend assets; exclude frontend build dependencies and private state from desktop packages.

This is an unsigned local preview. Public distribution, real account acceptance
and clean-machine installation remain separate release checks.

## 0.3.0-alpha.9 — 2026-10-28

- Fix connected-chat startup when Windows exposes a private profile through logical and physical folder aliases.
- Verify the physical profile boundary before forwarding both MCP paths under one consistent logical root; foreign and redirected profile directories remain blocked.

## 0.3.0-alpha.8 — 2026-10-28

- Fix VPN-free phone reconnects after suspended connections and cached-page restoration.
- Accept canonical invitation routes without signing out the currently paired person.
- Use stable Pages addresses for new setup and provide an explicit address update for existing hosts.
- Preserve pairing keys, private profiles and the host's selected deployment on startup.
- Keep Activity below the user's message in the phone interface and include the previous reply-adapter fix in the hosted update.

Verified with synthetic accounts and browser fixtures. Real iPhone cellular and
offsite relay acceptance remain separate checks.
# 0.3.0-alpha.16 — Public application source preparation

- Keep the maintained application under app/ alongside the existing website.
- Include contributor frontend/build/test inputs, notices and sanitized examples;
  exclude private runtime state, generated dependencies and development notes.
- Repair CLI archive packaging after frontend dependency installation while
  retaining private-file rejection and deterministic checksums.
- Strengthen the synthetic Windows upgrade regression to actually decrypt retained
  protected records, alongside unchanged-file checks.
- This source revision does not claim a signed installer, clean-PC pass or public
  download. Those remain separate candidate and installation-pilot gates.
# 0.3.0-alpha.17 — Reproducible Windows candidate preparation

- Include the audited public Hermes runtime snapshot, source hashes, licences and
  attributions; omit optional skill packs with separate dataset/licence requirements.
- Acquire exact public Python and wheel artifacts with checked hashes and sizes,
  then reuse the existing sealed-runtime and relocation verification.
- Require actual native, browser, runtime and MCP execution in candidate tests.
- Keep the sealed runtime unchanged across native chat/history by disabling the
  unused background toolchain probe and suppressing descendant Python caches.
- Share Family navigation's initial session lookup to prevent competing reads
  from leaving the profile controls unavailable on first load.
- Add scoped signing and immutable unpublished-draft delivery. A trusted signing
  identity, actual clean-PC installation/update and adult acceptance remain required.
