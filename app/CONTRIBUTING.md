# Contributing

Nemo makes Hermes approachable from a phone, including private family profiles,
simple connections, private history and honest live activity. The first public version uses only an eligible ChatGPT subscription. Memory/local-model modules are experimental groundwork, disabled in public entry points.

Use Node.js 22 or newer. Run `npm test` and `npm run check`. Tests use synthetic
data; never add real messages, credentials or private hostnames to fixtures.
Windows and macOS are the initial host targets. macOS credential behavior needs
real Keychain verification as well as mocked tests.

Preserve profile identity at server and execution boundaries. Never accept an
acting user from a model's arguments. Adding a tool requires permissions,
capability readiness, source-specific consent and tests for cross-profile access.
Keep Calendar outside Memory. Maintain deletion and late-callback protections.

Follow docs/DESIGN.md. New flows should explain what happens in plain language.
Do not mark tools Ready based only on installed code. Paid services require an
explicit setup choice. Do not widen OAuth scopes as an incidental refactor.

Submit small changes with relevant tests and a clear explanation of behavior.
Retain third-party notices and the MIT license when reusing code.
