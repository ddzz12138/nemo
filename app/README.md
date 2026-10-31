# Nemo — Hermes, for your family

**First public version: ChatGPT subscription only.** Use an eligible ChatGPT plan in Nemo’s guided desktop setup. No local AI model, Ollama installation, API key or model download is required or offered. Profiles and chat history stay on the PC; relevant conversation context is sent to ChatGPT for replies. Automatic Memory/embeddings, School notice and alternative-provider previews are deferred. Existing data is preserved.


**Source preview.** The first signed Windows x64 candidate and clean-PC pilot are
not yet released. Build instructions below are for contributors, not the
nontechnical installation journey. ChatGPT receives relevant conversation context;
this pilot does not claim that AI inference runs entirely on your PC.

Nemo is an independent, MIT-licensed desktop home for Hermes Agent, with phone access for the family. It adds
private family profiles, easier Google sign-in, private history and visible
agent activity. Windows and macOS are the initial host targets.

Main chat uses the guarded Hermes CLI bridge through the ChatGPT subscription broker. Advanced native-provider and local-model work remains experimental source, disabled in public entry points. Do not enable unrestricted tools by changing a toolset flag.

## Parent setup preview

The desktop uses one Ollama-derived interface from first launch to daily chat:
name, included assistant preparation, ChatGPT connection, private history,
Family and Settings, without a model picker or a second setup window.
The frontend uses Nemo's existing authenticated backend; it does not require
installing Ollama. See `docs/OLLAMA_INTERFACE.md` for provenance, checks and the
remaining Gmail/public-release requirements.

First launch guides a parent through their name and browser-based ChatGPT
sign-in. Phone access and account connections are optional Settings steps. It reuses private family
profiles and saved chats. The phone confirms the person's name before connecting;
parents do not enter network settings or API keys in this flow.

The desktop assistant now uses **Continue with ChatGPT** to connect the parent's
eligible existing plan. Nemo remains the interface and Hermes remains the agent.
ChatGPT plan limits and account usage settings apply; Nemo does not switch to
OpenRouter or another billing provider when a limit is reached. This connection
does not import the person's ChatGPT conversation history. See
docs/CHATGPT_PLAN.md for the connection, migration and verification details.

From the repository root, first `cd app`. Development:
`npm ci --ignore-scripts`, `npm ci --prefix desktop/interface --ignore-scripts`,
`npm run desktop:interface:build`, `npm run desktop:bootstrap`,
`npm run desktop:prepare`, `npm run desktop:prepare:node`, then `npm run desktop`.
The explicit bootstrap downloads Electron; the installer command selects its
bundled compression helper without running dependency install hooks.
The Hermes payload is prepared with the explicit release
recipe in docs/HERMES_BUNDLE.md. A fresh checkout does not contain private staged
runtime resources; complete verified resources are required before packaging.
The reproducible Windows recipe is now `npm run desktop:prepare:candidate`, using
the reviewed public runtime snapshot and pinned public Python/wheel inputs. See
[installation pilot](docs/INSTALLATION_PILOT.md) for build, signing and acceptance gates.
`npm run desktop:package` builds the Windows application folder;
`npm run desktop:make` builds the Windows installer. `npm run host:setup` opens the same
private setup controller from a source checkout. Close an existing managed Nemo
process before starting another instance on the same data and port.

This is a development preview. The staged Windows app includes verified Hermes,
Python, Node and phone-connector resources. It passed relocation, synthetic model
inference, real read-tool transport and packaged first-run preparation checks.
Parents can use local chat and saved history while phone access is unconfigured.
Live provider sign-in, hosted registration, an owned domain, signing and
clean-machine/physical-phone acceptance remain public-release checks. See
docs/DESKTOP_SETUP.md and docs/REMOTE_SERVICE.md.

## Current application

- Desktop **New Chat**, private conversation history and reopening saved chats
  to continue, with drafts kept separately for each conversation.

- Personal invitations and device sessions with private histories, calendar
  snapshots and Gmail grants per person.
- Personal passkey sign-in and explicit authenticated profile switching, while
  retaining invitation recovery. Child profiles start with chat only; the owner
  enables each tool separately.
- Visible, read-only parental review of child chat history,
  with an audit visible to the child. Adults remain private in the application.
- Google Web OAuth, focused read-only search with pagination, optional bounded
  snippet sync, inspection and clear/stop controls.
- iPhone Calendar Shortcut uploads. Calendar stays outside Memory.
- Actual live tool activity. Private conversations remain accessible through History.
- Tools/readiness, family classification, recent reply tasks and stopping a reply.
- Guided phone setup at `/setup.html`.
- Opt-in built-in phone connection at `/phone-access.html`: personal QR pairing,
  static HTTPS phone interface, encrypted WebRTC, reconnect and optional TURN.
  It stays off until an operator deploys the static interface. Real iPhone
  cellular acceptance is pending; see docs/PHONE_ACCESS_SETUP.md.
- Experimental Memory, local models and native-provider code remain available for
  development tests; the public application does not enable them.

Main chat retains the 90-second Hermes budget, six-call cap and roughly two-minute
timeout. Native chat enforces ten active minutes and up to 64 scoped read calls,
then pauses for explicit extension. Subagents and powerful computer/action tools
remain unavailable until their full execution boundaries are implemented.

## Install and run

Use Node.js 22+ and a configured, compatible Hermes installation. From source:
`npm ci --ignore-scripts`, `node bin/nemo.mjs host-setup`. Complete ChatGPT
sign-in in the guided setup. Later, `node bin/nemo.mjs start` reuses that connection.
Install a release archive with `npm install -g ./nemo-VERSION.tgz` to use `nemo`.
Run `nemo invite` on the host to create your private owner invitation.
`nemo stop` addresses this installation's managed CLI process, never an arbitrary PID.

Nemo binds loopback. Use private HTTPS; Tailscale Serve is the initial recipe.
The optional built-in phone connection is a separate source-preview route; its
static app export and operator-owned relay setup are in docs/PHONE_ACCESS_SETUP.md.
The host stays awake and online. No firewall, public tunnel, automatic startup
or sleep-policy change is installed. Existing installations retain `.nemo`.
New Windows installs use LocalAppData/NemoData, outside the Squirrel application
directory LocalAppData/Nemo; Mac installs use
Library/Application Support/Nemo. `NEMO_DATA_DIR` can select an absolute directory.

Windows uses DPAPI. The macOS Keychain adapter has synthetic tests but still
needs real-device verification. Reconnect accounts when moving operating systems.

## Setup

- Set `NEMO_PUBLIC_ORIGIN` or use setup for the HTTPS phone address.
- Hermes is discovered from PATH or a configured launcher. Bundled launchers must
  support `--print-runtime-command`. Compatible source installs can specify their
  environment Python and source directory. Unsupported shapes fail closed.
- Desktop users connect Gmail from Settings with Google sign-in; no Google Cloud
  Console or JSON import is needed. See [desktop Gmail](docs/GMAIL_DESKTOP.md)
  for publisher configuration and verification requirements.
- Operators who also need the separate phone Web OAuth flow configure a Google
  Web OAuth app with the exact
  `https://YOUR-NEMO-HOST/oauth/gmail/callback` URI. Import its JSON locally with
  `nemo gmail /absolute/path/client.json`; each person then uses Connect Gmail.
- Automatic Memory and local-model features are deferred; no Ollama models are
  required. Previous experimental stores are preserved. Gmail account changes
  fail closed if old Memory copies still need cleanup.
- Scalekit is optional. Its adapter remains planned; direct Gmail does not need it.
- The alternative-provider native preview cannot be enabled in this release.
  `nemo preview off` remains available to disable an older experimental setting.

## Privacy

Authenticated devices determine profile identity; model arguments cannot change it.
Each person has private account grants and chat history. Connections consent
governs retrieved material sent to ChatGPT. Automatic Memory learning and
embeddings are disabled in the public app.

The existing CLI bridge still uses the host Hermes home with shared context and
memory injection disabled. Preview native homes are separate per person, with
shared memory/context injection disabled and a broker-only network policy. That
in-process policy is not an operating-system sandbox for computer tools. Full
Docker workers remain a separate rollout step. The administrator can inspect
local storage. Legacy history/backups and preview transcripts are separate from
the main Nemo History deletion; full native deletion/migration is still pending.

## Development

After building the interface, run `npm test`, `npm run check`,
`npm run check:source`, `npm run package:release`. Packaging uses an
explicit source allowlist, excludes private state and generates checksums and a
manifest under `.work/releases`. Nothing is published automatically. CI definitions
need actual clean Windows/macOS runs before claiming release verification.

See CONTRIBUTING.md, SECURITY.md, THIRD_PARTY_NOTICES.md and docs/DESIGN.md.

Optional live GBrain tests use `NEMO_TEST_BUN` and `NEMO_TEST_GBRAIN_SOURCE`; no
maintainer-specific runtime paths are required. Optional Playwright checks resolve
the developer's installed package, or `NEMO_TEST_BROWSER_PACKAGE` pointing to its
package.json. These are distinct from the required release-native tests.

The source checkout omits the maintainer's `desktop/google-oauth.json`. ChatGPT
setup and chat work without this optional Gmail publisher configuration. An
installer offering public Gmail sign-in needs a reviewed public Desktop client
ID and the separate Google verification/access requirements in docs/GMAIL_DESKTOP.md.
