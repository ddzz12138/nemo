# Nemo's Ollama interface fork

Upstream: https://github.com/ollama/ollama

Pinned revision: `8861adaa77839c961d3c574232a8865d65a426b6` (29 October 2026).

This is a downstream interface adaptation, not a renamed Ollama inference server.
The collapsible sidebar/content structure and toggle graphic in `src/Layout.jsx`
are adapted from `app/ui/app/src/components/layout/layout.tsx` at that revision.
The original layout source is retained in `upstream/SidebarLayout.tsx` for review.
The conversation and composer use the upstream interface's restrained layout;
their state and network adapter are Nemo-specific. Ollama branding, model picker,
model downloads, account flow, tools and updater are not included.

Changes: Nemo navigation and orange accent, responsive sidebar, accessible toggle,
authenticated personal history and activity, existing ChatGPT plan display,
connection settings and Gmail handoff. All inference, profiles, permission checks,
saved history and Memory continue through Nemo's existing backend.

The upstream MIT copyright and permission notice is shipped in
`public/vendor/ollama-LICENSE.txt`. React and ReactDOM notices are retained in the
built bundle. No upstream assets, fonts or model weights are redistributed.

Developer build: `npm ci --prefix desktop/interface --ignore-scripts`, then
`npm run desktop:interface:build`. End users do not run npm or install Ollama.

The fork's live entry is `/desktop.html`. The original phone interface remains
available. Desktop setup and chat use separate sandboxed windows; chat has no
setup capability. Gmail connects in the system browser after explicit personal
profile confirmation. Public Google OAuth configuration, signing and clean-machine
installer verification remain release gates, not claims made by the interface.
