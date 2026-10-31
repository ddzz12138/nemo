# Third-party notices

The optional desktop chat interface adapts Ollama's MIT-licensed SidebarLayout
from commit `8861adaa77839c961d3c574232a8865d65a426b6`. Its copyright and permission
notice ships at `public/vendor/ollama-LICENSE.txt`. The source provenance and
changes are documented in `desktop/interface/UPSTREAM.md`. This interface does
not bundle the Ollama inference server, model weights or Ollama's account service.
React and ReactDOM 19.3.1 (MIT) are compiled into the local interface bundle;
their notices are retained in the generated asset. The build tools are excluded
from the desktop payload.

Built-in phone access uses Trystero Nostr/core 0.26.0 (MIT), Werift 0.25.2
(MIT), and noble-secp256k1 (MIT). Exact versions and integrity hashes are in
package-lock.json. The browser modules are served locally from
public/vendor/phone-link/, with each upstream licence beside its code. No
runtime script is loaded from a CDN. Public discovery and TURN services have
their own terms and availability; these software licences do not grant
unrestricted service access. Pion TURN is used only by an isolated development
fixture and is not bundled as a production relay.

Passkey verification uses MIT-licensed SimpleWebAuthn server 14.0.3. The locally
served SimpleWebAuthn browser bundle is version 14.0.0; its license is included at
`public/vendor/simplewebauthn-LICENSE.txt`. Runtime dependencies and integrity
hashes are pinned in package-lock.json. No sign-in script is loaded from a CDN.

Nemo is an independent project and is not an official Nous Research product.
Hermes Agent is copyright Nous Research and distributed under MIT. Its memory
curation guidance used by Nemo retains the notice in
references/hermes-memory-LICENSE.txt.

The source package uses a separately installed Hermes runtime. The Windows
desktop preview stages a verified Hermes source payload, standalone Python,
required Python distributions, Node and the phone connector. No model weights or
customer credentials are bundled. The Python inventory records exact versions
and includes upstream distribution licenses. GBrain, Ollama, local models,
Docker, Tailscale and optional connector services remain separate dependencies.
Review the licenses and terms of the exact versions installed.
The public package must not include unlicensed design reference screenshots.

The desktop preview uses Electron (MIT), Electron Forge (MIT),
electron-squirrel-startup (Apache-2.0), and qrcode 1.5.4 (MIT). Exact dependency
versions and integrity hashes are pinned in package-lock.json. License files
from shipped production dependencies and Electron's distribution accompany the
desktop application.

The staged Windows connector is Cloudflare cloudflared 2026.10.3, distributed
under Apache-2.0. The build fetches the official release binary and checks its
pinned SHA-256 before packaging. Include its upstream license and notices with
any distributed connector bundle. It does not contain customer credentials.

The tool bridge uses official Node.js 24.13.1 Windows x64 bytes checked against
the upstream release checksum. Its full upstream license and third-party notices
are included beside the executable in the desktop runtime's node folder.

Google OAuth grants and other account permissions belong to each user. Nothing
in Nemo's MIT license grants access to those accounts or to a provider service.

Selected school-notice text extraction uses htmlparser2 10.0.0 (MIT) and its
MIT-licensed parsing dependencies. Exact versions and integrity hashes are pinned
in package-lock.json; their license files accompany the shipped node_modules.
The parser does not load external pages, execute scripts or fetch images.
