# Portable Hermes runtime for Nemo

Parents install Nemo. They do not install Python, Git, pip, uv, Hermes, a virtual
environment or a terminal toolchain. Release preparation is an operator task;
the desktop setup screen offers a single assistant setup action using resources
already included in the installer.

## What the release builder does

`scripts/prepare-hermes-runtime.mjs` accepts four explicit absolute folders:

```powershell
node scripts/prepare-hermes-runtime.mjs `
  --source <reviewed-clean-Hermes-checkout> `
  --python <standalone-Windows-Python-folder> `
  --site-packages <prepared-wheel-dependency-folder> `
  --out <new-release-output-folder>
```

It does not read existing Hermes configuration, auth files, provider keys,
session stores, memories, `.env` files or browser profiles. The dependency input
can be an installed environment's **site-packages code directory**; its parent
virtual environment is not copied. No `pyvenv.cfg`, interpreter redirector,
console-script executable or activation script from that environment is used.

The source checkout must have a clean tracked revision and pass Nemo's existing
`hermes-native-contract.json` compatibility hashes. A Git tracked-file list is
filtered through a runtime source/module/resource allowlist. Developer frontends,
tests, installers, `.git`, `.hermes`, `.env*`, caches and credential/state files
are excluded. Untracked code cannot enter the release. The complete selected
source snapshot is then hashed, rather than relying on its commit label alone.

The builder reads `pyproject.toml` core requirements **plus its explicit `mcp`
extra**, evaluates Windows/Python markers and requested dependency extras, and
resolves their transitive closure against the
prepared installed metadata. Each selected version must satisfy its declared
requirements. Direct URL dependencies require a separately reviewed wheel build;
they are refused by this lane. Every copied wheel file must have the expected
SHA-256 and size from that distribution's RECORD. It does not import those
packages during dependency planning.

Editable import pointers, `_virtualenv.pth`, `direct_url.json`, environment
launchers and compiled bytecode are discarded. Only the reviewed relative
`pywin32.pth` is retained because PyWin32 requires its relative `win32`, `win32/lib`
and `Pythonwin` paths and bootstrap import. Absolute paths back to the selected
build-machine input folders are refused. Private keys and arbitrary certificate
files are excluded; the exact public `certifi/cacert.pem` is included and verified
against its wheel RECORD because HTTP client initialization requires it.

The selected standalone Python executable, runtime DLLs and standard library are
copied without pip/ensurepip, development headers, debug symbols or an existing
dependency environment. The required verified dependency files are placed in its
own `Lib/site-packages`.

## Relocatable layout

```text
desktop-runtime/
  manifest.json                  Nemo release manifest; merges existing fields
  hermes/
    inventory.json               Every shipped file's relative name, size and hash
    dependencies.lock.json       Exact Python and dependency versions
    THIRD_PARTY_NOTICES.txt      Source/dependency license inventory
    manifest.json               Hermes's native sealed-payload layout
    python/python.exe
    python/Lib/site-packages/
    python/LICENSE.txt
    source/hermes_bootstrap.py
    source/install-stamp.json
    source/LICENSE
```

The inner manifest declares `repo: source`, `venv: python`, `store: tools` using
relative paths. Hermes's existing bootstrap recognizes that sealed layout and
selects its bundled site-packages. Its external update steward prevents source
self-update. No Hermes bootstrap or compatibility-pinned agent source is patched.
Nemo starts the bundled Python directly, so an absolute virtual-environment
shebang is unnecessary.

The top-level `hermes` object retains `python`, `pythonSha256` and `source`, and
adds `inventory`, `inventorySha256`, `sourceRevision`, `pythonVersion`,
`dependencyLockSha256` and `verification`. Existing connector/Node manifest fields
are preserved. The lock, inventory and `hermes` manifest object all record
`extras: ["mcp"]`; verification returns that inventory-backed list so installer
preflight can refuse a payload missing Nemo's read-connection transport. No
other optional Hermes extra is selected. Do not run separate manifest
publishers concurrently.

`verifyHermesBundle({root, manifest})` checks the pinned inventory hash, every
listed file's hash and size, relative path containment, linked files/folders,
unexpected added files, import pointers, prohibited state and the native
compatibility contract. The Python executable must occur in that inventory with
the same digest as the manifest. Nemo's runtime installer and managed startup
must call this verifier before accepting the bundle.

## Actual runtime verification

Before publication, the builder physically renames the completed folder, then
starts its Python from an unrelated working directory. The process receives a
new empty HOME, USERPROFILE, LOCALAPPDATA and HERMES_HOME, a minimal Windows-only
PATH, no real account credentials, and disabled lazy installation.

It checks that the interpreter prefix/executable resolve under the moved bundle,
runs actual Hermes `--help`, and imports both Hermes and OpenAI from that bundle.
It then creates a real `AIAgent` with no tools and completes a conversation against
a temporary synthetic OpenAI-compatible server on `127.0.0.1`. The test server
advertises the context size Hermes requires; it returns a fixed synthetic reply.
Socket connection guards permit only loopback. No real inference account or
charge is involved.

`-I -B` and `sys.dont_write_bytecode=True` protect the immutable resources. Probe
state and evidence are placed outside the shipped runtime directory. After the
engine run, the builder refuses added files or changed release bytes and verifies
the complete inventory again. `verification.fakeProvider` is true only after
the actual engine receives the synthetic reply.

The lane was exercised on the reviewed Hermes revision
`02628e07d7ce56283e5fed612f8bef3cbcbb3dfe` with standalone Windows x64 Python 3.14.7.
The verified component contains 10,252 files and 265,050,295 bytes, with 89
dependency distributions including the MCP transport and JSON Schema validation.
Full verification at its final staged release path took 16.7 seconds during the
latest development run; this is a measurement, not an install time promise.
A help-only probe initially
missed a public CA file; the actual provider probe exposed that defect, which
this builder now catches before publication.

The concrete operator invocation used for that component was:

```powershell
node scripts/prepare-hermes-runtime.mjs `
  --source C:\NemoBuild\hermes-source `
  --python C:\NemoBuild\python `
  --site-packages C:\NemoBuild\site-packages `
  --out C:\NemoBuild\runtime
```

The builder refuses to replace an existing `hermes` output. For another build,
select a fresh output folder, run all verification, then promote only its
`hermes` component and manifest field into `desktop-runtime`, preserving Node
and connector fields. Before moving a component, resolve and check both source
and target remain under the intended release workspace. Preserve the previous
component as a backup. The prepared resources now live at
`.work/desktop-runtime/hermes`; the temporary build location is not used by the
desktop application. These operator paths are never presented to parents.

The actual combined regression check ran `test/hermes-mcp.test.mjs` under the
**shipped Node executable**, with `NEMO_TEST_PYTHON` and `NEMO_TEST_HERMES_ROOT`
pointing at this bundled Python/source and `NEMO_TEST_HERMES_HOME` pointing at a
new synthetic workspace home. It discovered only Nemo's approved read schemas,
executed a real synthetic calendar read over MCP stdio, and verified handler and
schema tampering are refused. It passed in 9.1 seconds. The full inventory is
checked again afterward to detect writes to release resources. This catches
transport dependencies that a tool-free inference probe alone cannot exercise.

## Licenses and release limits

The artifact includes Hermes's MIT license, Python's license, the selected
distributions' recorded license files and a package/version/license inventory.
`dependencies.lock.json` pins the prepared dependency set; the inventory pins
its actual bytes. RECORD checks establish consistency with the prepared wheel
metadata. A public release must still use reviewed upstream artifact provenance
and the project's installer signing/release process.

This lane includes the runtime for Nemo's current supported agent capabilities.
It does not install optional browser binaries, arbitrary plugin dependencies or
every Hermes provider extra on a parent's first launch. Existing capability and
native compatibility policies continue to apply.

Passing the relocated synthetic probe establishes that these resources execute
without the developer's Python, dependency paths or Hermes home. A clean-machine
installer test, signed release, actual provider sign-in, and real phone access
remain distinct release checks. A domain or registration service is not
configured or deployed by this builder.

`test/hermes-bundle.test.mjs` covers source exclusion, full inventory verification,
relocation of relative artifacts, tampering, unlisted files, private state,
absolute import pointers, the public CA exception and manifest traversal.
