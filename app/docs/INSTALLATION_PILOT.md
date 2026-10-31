# Windows candidate and first installation pilot

The app source and runtime snapshot are public. A passing source/build job is not
a signed release, a successful clean-PC installation or an observed adult pilot.

## Contributor build

From `app/`, use Node 24.13.1 on Windows x64:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm ci --prefix desktop/interface --ignore-scripts --no-audit --no-fund
npm run desktop:interface:build
npm run desktop:bootstrap
npx --no-install playwright install chromium
npm run check:source -- --tracked
npm run desktop:prepare:candidate
npm run test:release
npm run desktop:make
```

The runtime recipe obtains the pinned public Python archive and exact PyPI wheel
bytes in `desktop/hermes-release.json`. It uses the public, exact-byte Hermes
snapshot described in `desktop/hermes-source.json`. Downloads are hash/size checked,
including cache hits. Extracted interpreters/dependency trees are fresh each run.
No private repository, personal Hermes home, provider grant or model download is
needed. Actual inference/tool checks use synthetic loopback providers.
The runtime's Git revision identifies the public Nemo commit containing the
vendored tree. `sourceSnapshot` additionally records the original engine revision
and source-lock hash; these are distinct provenance fields, not interchangeable.

`test:release` requires Electron, bundled Node/Python/Hermes and Playwright. It
fails if required native, runtime, MCP or browser paths skip. The named optional
live GBrain round trip is outside this ChatGPT desktop pilot. Keep the resulting
test report and runtime inventories with the source revision.

## Trusted draft candidate

The Windows workflow has two boundaries: read-only build verification on PRs/main,
and a maintainer-triggered signing/draft job from reviewed `main` only. Read-only
jobs do not upload the diagnostic installer. No ordinary Actions artifact is an
installer delivery channel.

Publisher signing access is not yet supplied. The included adapter accepts an
existing eligible trusted PFX via the protected environment secrets
`NEMO_SIGNING_PFX_BASE64` and `NEMO_SIGNING_PASSWORD`, with expected certificate
thumbprint in `NEMO_SIGN_EXPECTED_THUMBPRINT`. A hardware/cloud signing provider
requires its provider integration before enabling this job; do not assume its key
can be exported as a PFX. No certificate/service is purchased by the workflow.
Self-signed credentials do not satisfy final trusted-publisher verification.

Nemo.exe is signed before Squirrel packages it; NemoSetup.exe is signed afterwards.
Pinned third-party runtime bytes are preserved. Final verification requires the
expected trusted signer and timestamp, records final hashes, and rechecks the
packaged sealed runtime. Child runtime signatures/security behavior are part of
the clean-PC check; parent signing does not claim every third-party binary is
Nemo-signed or guarantee warning-free installation.

The result goes to a unique unpublished draft with installer, Squirrel metadata,
checksums, source/runtime provenance, tests and signature evidence. `candidate.json`
uploads last; missing/inconsistent assets mean incomplete. Existing assets are
never overwritten and published releases are never reused. The manifest marks
clean-PC and adult acceptance pending. A maintainer verifies downloaded hashes
and signatures before any individual handoff. Public publication is separate.

## Required acceptance

Use a separate clean Windows x64 PC with normal protections and no old Nemo,
Node/Python/Hermes developer installation supplying hidden dependencies. Record
the Windows edition/version and exact candidate identity. Test actual install,
shortcut, owner setup, synthetic reply, New Chat/history, quit/reopen, offline
recovery, logout/revocation and retained private storage.

Install two actual compatible Squirrel versions with synthetic protected accounts.
The upgraded app must read the original account through its normal secret loader,
under the same Windows user, without reconnecting or reseeding. Unchanged
ciphertext alone is insufficient. Record Windows warnings/blocks as results;
do not relax protections to turn a failed installation into a pass.

Only after these checks, observe a consenting nontechnical adult on their own PC
with their own eligible ChatGPT account: install, name/profile, browser sign-in,
first reply, New Chat, earlier chat from History, close/reopen with identity kept.
Explain that relevant context reaches ChatGPT. They should need no terminal or
developer intervention. Record durations, errors and every help request, excluding
passwords/tokens/private conversation content. Gmail, phones and local-model user
acceptance are later passes. No outreach or recording is automatic.
