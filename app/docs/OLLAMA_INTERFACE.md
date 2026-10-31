# Ollama interface adaptation for Nemo

Implementation status: 31 October 2026, Australia/Sydney.

Desktop updates retain the personal sign-in, completed setup and protected
account records. See `DESKTOP_SETUP.md` for the browser-era one-time profile
confirmation and expiry/revocation behavior.

The current preview is **0.3.0-alpha.14**. Desktop Gmail connects through Google
in the system browser, without end-user Google Cloud configuration or phone
setup. Gmail remains optional. Publisher verification and a real-account
authorization check remain separate release requirements. See `GMAIL_DESKTOP.md`.

The user explicitly chose a fork of Ollama's interface. This revision adapts
its sidebar layout into Nemo's desktop app and connects the conversation and
Settings screens to Nemo's existing profile-aware backend. It does not replace
Hermes with Ollama's inference server.

## Evidence and boundaries

The investigation used the complete public source at Ollama revision
`8861adaa77839c961d3c574232a8865d65a426b6`. This follows REA's source-repository
route: no disassembler, packaged-app inspection or runtime tracing was needed.
The following labels identify source evidence; they are not REA-generated IDs.
Static source inspection does not prove a released binary behaves identically.

| Evidence | Observed source | Consequence for Nemo |
| --- | --- | --- |
| S1 | [Desktop startup](https://github.com/ollama/ollama/blob/8861adaa77839c961d3c574232a8865d65a426b6/app/cmd/app/app.go#L186) opens an ephemeral loopback UI listener and separately starts its server. | Preserve the separation between the desktop interface and the assistant service. |
| S2 | [SidebarLayout](https://github.com/ollama/ollama/blob/8861adaa77839c961d3c574232a8865d65a426b6/app/ui/app/src/components/layout/layout.tsx) defines collapsible navigation and a flexible content region. | This is the directly adapted upstream component; retain its MIT notice and source provenance. |
| S3 | [API adapter](https://github.com/ollama/ollama/blob/8861adaa77839c961d3c574232a8865d65a426b6/app/ui/app/src/api.ts) calls Ollama-specific chat, model, settings and account routes. | Replace those calls with Nemo's authenticated HTTP contracts. Changing a logo or hiding a model picker alone would not produce a working Nemo client. |
| S4 | [Settings](https://github.com/ollama/ollama/blob/8861adaa77839c961d3c574232a8865d65a426b6/app/ui/app/src/components/Settings.tsx) manages Ollama cloud/account/model behavior. | Do not connect Nemo users to Ollama's account service or import its model configuration. |
| S5 | The reviewed [released initial database schema](https://github.com/ollama/ollama/blob/8861adaa77839c961d3c574232a8865d65a426b6/app/store/schema.sql) has app-wide settings and chat/message tables. | It is not evidence of Nemo's family authorization boundary. Keep Nemo's existing profile ownership checks. Later Ollama migrations were not audited for family support. |
| S6 | [Windows app](https://github.com/ollama/ollama/blob/8861adaa77839c961d3c574232a8865d65a426b6/app/cmd/app/app_windows.go) provides tray/window lifecycle, while [the installer](https://github.com/ollama/ollama/blob/8861adaa77839c961d3c574232a8865d65a426b6/app/ollama.iss) packages Windows resources. | Nemo already has its own Electron/Squirrel runtime packaging, so reuse it around the forked interface. No Ollama-branded updater is included. |

The MIT copyright and permission notice is preserved in
`public/vendor/ollama-LICENSE.txt`. Original SidebarLayout source and a record
of the adaptation are in `desktop/interface/upstream/` and `UPSTREAM.md`.

## Working implementation

- `/desktop.html`: locally served React interface with collapsible sidebar,
  private main-chat history, the current person's name, an understated orange
  accent, a composer and real reply activity.
- No model picker, model download, Ollama account or API-key form. The existing
  ChatGPT connection selects an authorized model in the backend.
- First launch, chat, Settings, Family and Memory share one Ollama-derived
  layout and one sandboxed desktop window. Name entry prepares the bundled
  assistant; ChatGPT sign-in and plan acknowledgement precede personal chat.
- Settings includes owner ChatGPT/account/start-at-login/phone controls and each
  person's own Gmail, calendar and saved tool consent. Family includes device
  management, invitations, self-renaming and explicit recorded child review.
- One named preload replaces the separate setup/chat preloads. The capability
  stays in main. Setup actions require either the exact private setup document
  or the exact personal document plus a current owner session matching the
  displayed profile ID. Members, subframes and stale callers are rejected.
- Setup can reopen an existing signed-in chat without generating unused invites.
  A signed-out window receives a fresh invitation and must confirm its person.
- Gmail sign-in opens directly from Settings through native main. Its temporary
  loopback callback is bound to the authenticated profile/device, with PKCE,
  cancellation and protected storage. It does not create a browser invitation
  or depend on phone Web OAuth. Tokens and OAuth URLs stay out of the renderer.
- HTTP mutations pin the profile displayed by the client. Late responses after
  an identity change are rejected; a separate revision guard prevents an old
  same-person refresh from erasing a newly accepted reply. Uncertain sends retain
  the same request ID for safe retry; no second reply is created on replay.

**New Chat** starts a fresh conversation. Populated chats remain under **Your
conversations**, and selecting a saved chat reopens it for continued replies.
Drafts are scoped to the person and conversation. Switching waits for the current
reply, and sends pin the displayed conversation so stale tabs cannot append to
another chat. Active and archived chats persist together in the profile’s atomic
state file; the old archive is imported once and retained as a backup.
Native-preview controls remain separate. Memory and Family keep their existing
React views, and the phone screens remain active.
Assistant replies support basic Markdown through fixed React elements; model
HTML and executable links are never rendered. Gmail can remain disconnected,
and connection-readiness errors stay inside Settings.

## Account setup and public-release gaps

OpenAI's [official open-source sign-in documentation](https://developers.openai.com/siwc/token-sharing-open-source)
supports eligible ChatGPT plan usage through browser authorization. This does
not import ChatGPT conversation history. Nemo already implements the connection;
this revision does not change that authorization protocol or verify a new live
account. The active provider subscription is currently managed for the home;
different family members' private context does not imply a different ChatGPT
subscription per person.

Gmail uses Google’s own sign-in and read-only permission. A release contains
only Nemo’s public Desktop client ID; existing operator configuration is kept.
Google classifies `gmail.readonly` as restricted, so public verification still
needs to be established by the publisher. The current tests use fictional
Google replies and do not prove acceptance by a real account.

Signing, automatic updates, clean Windows installation and macOS acceptance
remain release work. The current source does not establish those outcomes.
Existing phone deployment is optional and remains configured separately.

## Verification

- Frontend production build succeeds; isolated pinned build dependencies report
  zero vulnerabilities at installation. React/ReactDOM and Ollama notices ship
  beside the compiled, locally served assets.
- Full suite: **520 passed, 12 skipped, 0 failed** (532 tests).
- Syntax: **126 JavaScript files checked**.
- New tests exercise displayed-profile headers, stale-response rejection,
  same-person snapshot ordering, fixed Gmail continuation, navigation/IPC
  boundaries, packaging exclusions and actual two-profile HTTP conversations.
  Guessed run IDs return no other person's answer; request replay creates one
  provider call. Existing pairing tests now cover the Gmail continuation.
- Independent source review identified four issues; all were fixed and rechecked.
- Bundled runtime verification passes: 10,252 assistant files, 89 distributions,
  pinned Node and connector. No real account, Gmail data or model inference was
  used for this verification.
- The isolated Windows application package passes its real hidden first-launch
  and runtime-preparation checks using a fresh synthetic directory and separate
  port. Its desktop HTML/script are served, private conversation APIs reject an
  anonymous request, 11 packaged source/assets match, and private/build trees
  are excluded. This is a startup/HTTP check, not a visual conversation test.
- Browser checks now cover actual pairing confirmation, a simulated reply,
  formatted message content, disconnected-Gmail Settings, sidebar navigation,
  Escape dismissal and overflow at 320, 768, 1024 and 1440 CSS pixels. No browser
  console warnings/errors were observed. The fixture is clearly labelled and
  uses a separate synthetic directory, profile and provider.
- Resuming the current conversation from the sidebar and sending another
  message were verified. Parser tests cover literal HTML, list numbering and
  bounded formatting. The full suite was rerun after the resume fix.
- Real ChatGPT/Gmail authorization and clean-machine installation are not
  established by those UI checks.

Alpha.11 additionally passed a real Electron Session cookie round-trip against
the profile server: owner settings accepted; member, stale-profile and signed-out
settings rejected. Browser checks followed first launch through simulated
ChatGPT acknowledgement, explicit personal confirmation, Family creation,
recorded child review, Settings and deliberate owner-to-child switching. Native
menu/invitation fragment navigation works without a full page reload. No browser
console warnings/errors or horizontal overflow were observed at 320, 768, 1024
and 1440 pixels. Those visual checks used labelled synthetic accounts.

The obsolete host wizard HTML/JS/CSS and separate chat preload were deleted.
The old phone/setup guides, public family/Memory pages and provisioning services
are still used and remain. No private family data was migrated or deleted.

## Current alpha.11 Windows preview

The current build output is
`.work/unified-desktop/release/make/squirrel.windows/x64/NemoSetup.exe`.
Its final `.sha256`, installer inspection and packaged startup records are stored
beside the artifact or under `.work/unified-desktop/`. The installer is unsigned;
it is a local preview, not a published release or clean-machine acceptance.

Final installer inspection matched 13 current source/assets, retained the upstream
notice, and excluded private/build directories and the removed wizard/preload.
The packaged app passed real hidden first launch and bundled-runtime preparation.
The visible Windows app was also opened at the new Welcome to Nemo screen using
a separate fresh preview directory. Existing installed family data was untouched.

## Earlier alpha.10 Windows preview

The unsigned preview installer is at
`.work/desktop-interface-visual/release/make/squirrel.windows/x64/NemoSetup.exe`.
It is 303,946,752 bytes; its sibling `.sha256` file records
`e911165fd08e092894fb2220c3076c567d92ea840ab6c2789f42b6d6961d0d34`.
The final archive's compiled interface matches the current source build,
including the current-conversation resume fix. Private/build directories are
excluded, the Ollama notice is present, and the sealed runtime contains no
filler files. The packaged app passed its isolated first-launch check. The
installer was built and inspected, not installed or published.

The browser preview uses `test/fixtures/desktop-interface-preview.mjs` with
fictional data and simulated replies. Its screenshot and verification records
are in `.work/desktop-interface-visual/`. Real ChatGPT authorization and
clean-machine installation remain acceptance checks.

Public Google Cloud configuration is deferred. The operator considered a new
project, then explicitly chose to skip Gmail for this pass. Existing configured
Google connections remain available; no OAuth clients or Google project
settings were changed. Installed Nemo and family data were not replaced.

## Earlier alpha.9 Windows preview

The unsigned preview installer is at
`.work/ollama-study-2026-10-29/package/make/squirrel.windows/x64/NemoSetup.exe`.
It is 303,907,328 bytes; its sibling `.sha256` file records
`4a57a418a77b0a6b7ef1e268a5b05a19f64eb10804dec8981cb61d1f2b8fcd15`.
The installer archive contains the tested compiled interface and upstream notice,
excludes private/build directories, and introduces no filler files inside the
sealed Hermes runtime. It has been built and inspected, not installed or
published. Existing installed Nemo and family data were not replaced.

Developer build: `npm ci --prefix desktop/interface --ignore-scripts`, then
`npm run desktop:interface:build`. The built assets are included by the normal
desktop packager. The nested frontend build directory is explicitly excluded
from the runtime payload. Nothing in this revision publishes or installs it.
