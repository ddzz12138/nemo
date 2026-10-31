# Nemo desktop setup

The Ollama-derived desktop interface handles first name, bundled assistant
preparation and ChatGPT sign-in in one window. Family, Memory, personal accounts
and optional phone access live in the same software. Parents never enter network
settings, terminal commands, runtime paths or API keys in this flow.

Desktop Gmail now uses **Settings → Connect Gmail → Google sign-in → return to
Nemo**, independently of phone/Web OAuth. Family users do not configure Google
Cloud. See [Gmail desktop setup](GMAIL_DESKTOP.md) for the publisher configuration,
protected storage, cancellation guarantees and outstanding real-account check.

## Updating an existing installation

Run the newer Nemo installer over the existing installation. Keep the same app
identity and private data directory; do not uninstall or delete data first.
Windows stores profiles, chat history and protected account records in
`%LOCALAPPDATA%/NemoData`, outside Squirrel’s versioned application directories.
An explicitly configured data directory remains authoritative.

The desktop keeps the same persistent personal-cookie partition across releases.
Login and logout cookie changes are flushed to disk, and normal shutdown drains
that persistence queue before exiting. Updates retain the original session
expiry; they do not extend its 90-day lifetime or revive a revoked device.

A valid desktop session opens the existing chat directly, including when an AI
connection temporarily needs attention. Finished setup is retained independently
of current provider readiness. A temporary session-read failure preserves the
saved sign-in and reports a retry; it cannot create new setup or an invitation.

The first move from the older **browser-based** alpha.9 interface may require
one **Continue as [name]** confirmation because the browser and desktop have
separate cookie stores. This reuses the existing profile, chats, ChatGPT/Gmail
connections and setup; it does not ask the person to reconnect those accounts.
Later desktop upgrades restore the saved desktop session. An expired, revoked
or explicitly signed-out session still requires personal sign-in, while keeping
the person’s data and completed setup.

If a signed-out desktop window loses its invitation during a reload, choose
**Continue on this PC**, then **Continue as [name]** and confirm the profile.
This native-only recovery returns to the existing host setup without requesting
a family code. Completed setup can reopen saved chats while the assistant is
disconnected. An already signed-in family member stays in their own settings;
recovery never silently switches them to the owner. Ordinary browsers and phones
still require a personal invitation. Failed native Settings requests show a
retry message instead of silently doing nothing.

## Implemented source

The Ollama-derived desktop chat interface is documented in `OLLAMA_INTERFACE.md`.
The desktop **Continue as [name]** action reuses the same sandboxed window for
personal profile confirmation and chat. A single React bundle renders both the
private setup document and authenticated personal interface. The local CLI uses
the same setup layout with a fragment capability fallback.

- `desktop/main.cjs` opens one app window and keeps the host running
  when the window closes. The tray menu reopens Nemo or explicitly quits it.
  Start at login is a separate, opt-in checkbox.
- `desktop/host-process.mjs` runs the existing backend with Electron's Node
  utility process. Packaged users do not need a separate Node installation.
- The window has no Node access. A sandboxed preload exposes named setup actions
  and the start-at-login preference. Only the main process holds the setup
  capability. Main accepts these actions only from the exact private setup
  document or the exact personal document with a live owner session and matching
  displayed profile ID. Subframes, members, signed-out callers and changed
  documents fail closed. Browser sign-in opens in the system browser and is limited to the
  release's registration service origin or OpenAI's exact sign-in path. Manage
  usage opens a fixed ChatGPT settings address; the renderer cannot choose URLs.
- `desktop/interface/src/Setup.jsx` presents first launch and the owner's PC
  settings. The first name comes from the local
  profile registry. Setup never presents a QR before the real host readiness
  checks permit pairing. The QR is encoded with `qrcode`; it is not a mock image.
- `FamilyPage.jsx`, `FamilyReview.jsx` and `MemoryPage.jsx` reuse existing
  authorized APIs inside the shared sidebar. The desktop does not navigate out
  to the old phone pages. Those phone pages remain active and are retained.
- `lib/assistant-onboarding.mjs` connects an eligible existing ChatGPT plan with
  browser sign-in, S256 PKCE, state and OIDC nonce/signature validation. It uses
  Nemo's own dynamic registration and a stable installation identifier. The
  callback is `/auth/callback` on a private ephemeral loopback port. Tokens and
  each registration's account identity stay in the protected backend store.
- Hermes sends inference through a capability-protected local adapter to the
  official OAuth Responses endpoint. A reply must reach `response.completed`.
  Plan limits stop that reply; they never select another paid provider. First
  use explains the plan allowance, and the app links to ChatGPT's usage settings.
- `Pairing.jsx` (desktop) and `public/pair.*` (phone) remove the invitation fragment immediately, preview the
  server's intended profile, and asks the person to confirm before redemption.
  A phone already signed in must explicitly sign out before confirming another
  profile. A visible family review notice is preserved where applicable.
  Success offers chat, a personal passkey, and Home Screen instructions.

An unavailable phone service does not block use on the computer. Once the
assistant is connected, setup offers **Continue as [name]**. The desktop
obtains a fresh five-minute invitation for the owner, validates the exact local
application origin in the main process, and opens the personal view in the same window. The person
confirms their name before signing in. This local invitation is never displayed
as a phone QR. Local pairing also works when a managed HTTPS address is already
configured; local browser cookies stay separate from the external host.

Reopening Nemo restores the signed-in person's chat directly, including saved
history, without showing setup first. Startup loads a private local bootstrap document in
the hidden window before checking its session: Electron can otherwise omit a
saved SameSite cookie before its first page load. Only the final destination is
shown. This preserves a signed-in family member instead of switching to the owner.
An already configured installation that previously used the system browser needs
one personal confirmation in the desktop app; it does not repeat setup or sign
in automatically. Fresh installations and unacknowledged plan usage still show
setup. A signed-in person can read chat and use Settings when ChatGPT needs to
reconnect.

Completed setup is recorded separately from current connection readiness. Older
installations are recognized by an existing paired owner device, including after
sign-out or expiry; this never authenticates that device again. Disconnecting
ChatGPT does not return an existing installation to onboarding. The desktop
opens its personal chat in the same application window. A finished installation
can confirm its desktop profile and read saved chat while ChatGPT is disconnected;
reconnecting the provider remains a separate action in Settings.

If an account is saved but assistant startup failed, setup keeps the account
recovery message visible and retries startup using the saved connection. It does
not ask the parent to repeat sign-in or create an API key. Old OpenRouter
credentials never authorize this desktop route; the parent connects ChatGPT
explicitly. Existing chats, profiles and phone settings remain saved.

## Private launcher contract

`startDesktopHost({dataDir,resourcesPath,openExternal})` returns
`{bootstrapUrl,close}`. The utility child reports readiness over its parent
message port. The main process validates an exact ephemeral `127.0.0.1` setup
address, retains its capability, and loads the page without the fragment.

For local browser development the setup launch URL can carry `#setup=…`;
`public/desktop-setup.mjs` immediately removes it and holds it only in memory. Setup APIs
require the capability plus exact local origin. That port must never be a
tunnel target. The published application listener cannot perform local setup.

Desktop data uses the existing portable `defaultDataDir()` policy, preserving
the current installation and saved chats. `NEMO_DESKTOP_DATA_DIR` is an explicit
absolute override for isolated development or QA.

On Windows, alpha.6 and later use `%LOCALAPPDATA%\NemoData` for new private data,
separate from Squirrel's `%LOCALAPPDATA%\Nemo` application directory. Squirrel can
replace that entire application directory during installation. Before updating
an older preview whose data is colocated there, quit Nemo, make a verified private
backup and migrate the private files into `NemoData`; keep existing profile IDs,
protected account records and history together. Rebase an assistant-home path
inside the old private folder, while allowing managed bundled runtime paths to
refresh normally. Do not restore process-discovery secrets as live controllers.
The existing source-checkout `.nemo` and explicit data-directory overrides retain
their precedence. Automated legacy installer migration is a public-release gate.

The release's registration origin is an operator build setting in
`desktop-runtime/manifest.json`, not a setting parents configure. An environment
override is available for development. If no actual service or verified runtime
bundle is available, this preview explains that honestly and cannot enable
phone access.

## Verification performed

`test/desktop-setup.test.mjs` covers fragment removal before requests, explicit
profile confirmation, deliberate switching, invitation expiry, named desktop
IPC requests, loopback bootstrap validation, allowlisted external sign-in and
packaged utility launch paths.

`test/assistant-onboarding.test.mjs` exercises actual local HTTP callbacks with
synthetic ChatGPT responses: PKCE/state/nonce, signed identities, wrong hosts and paths, concurrent
callbacks, replay, expiry, failed exchanges and protected credential restoration.
No live provider account or production connection is used by these tests.

The optional browser tests drive real local setup and family APIs through an
explicitly labelled synthetic desktop bridge. They cover first launch, plan
acknowledgement, family creation, optional phone controls and explicit identity
switching. Setup, provider replies and Windows settings are simulated in this
fixture. Playwright is an optional QA dependency rather
than part of the shipped app; existing browser test environment variables select
its package and installed browser channel.

`test/fixtures/desktop-native-access.cjs` separately checks real Electron session
cookie round-trips against a real profile server. Owner management succeeds;
member, stale-profile and signed-out management fail. It uses synthetic profiles
and no model/provider account. This does not establish live OAuth acceptance.

The unused `public/host-setup.html`, `.js`, `.css` and `desktop/chat-preload.cjs`
were deleted. `public/setup.html` and `setup.css` are still used by phone/calendar
help. The private setup server, provisioning, OAuth and host process are reused.

For packaged startup QA, `NEMO_DESKTOP_SMOKE=1` additionally requires an explicit
absolute `NEMO_DESKTOP_DATA_DIR` containing only synthetic test data. It keeps the
actual main window hidden, verifies utility-process startup and the sandboxed
preload's status request, checks the first-name form, writes only safe booleans
and the static heading to `desktop-smoke-result.json` in that data directory,
and quits. It adds no renderer API or public HTTP endpoint.

Adding `NEMO_DESKTOP_SMOKE_INSTALL_RUNTIME=1` asks that same isolated startup
check to run the real named runtime preparation action before recording
`runtimeReady` and `runtimePythonIsBundled` booleans. It verifies the saved Python
location is inside the packaged runtime without writing that path to results.
This option does not sign in to a provider or request model inference. Normal
app startup never performs this QA action automatically.

## Release boundaries

From a source checkout, install build dependencies with `npm ci --ignore-scripts`
and run `npm run desktop:bootstrap` to download the pinned Electron runtime.
Prepare the release resources as described in `HERMES_BUNDLE.md` and the README,
then run `npm run desktop:make`. That command verifies the complete runtime and
selects the bundled Windows compression helper before invoking Forge. It avoids
the broken architecture-selection install hook in electron-winstaller 5.4.4.
These are operator build steps; installed parents use the Nemo setup window.

The Windows preview stages verified Hermes/Python, Node and connector resources.
The packaged app passed its actual assistant-preparation step with a fresh
synthetic data folder and development tools removed from PATH. The portable
engine also completed a synthetic model reply and exact read-tool MCP checks.
Forge builds the Windows Squirrel installer. Public distribution still requires
a live registration service and owned domain for phone access, signing, and a
clean Windows installation test. Verify
the whole journey on a physical phone using mobile data with no VPN, including
reopened history, tool activity, sleep/offline recovery and remote revocation.

The macOS ZIP target is source preparation only. Building, signing, notarizing,
Keychain behavior and setup must be verified on a Mac before offering it to
parents. The Windows payload and packaged first-run checks do not replace a
clean Windows VM/physical-device acceptance test or establish a live remote
service.

ChatGPT sign-in and plan protocol references:
https://developers.openai.com/siwc/token-sharing-open-source/sign-in
https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference

Electron utility process reference:
https://www.electronjs.org/docs/latest/api/utility-process
