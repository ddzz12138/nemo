# Private Node runtime for Nemo connected tools

Parents should not install Node or change PATH. Nemo's Electron utility process
runs the main application, while the private read-only MCP tool server needs an
actual `node.exe`. An Electron executable cannot replace that tool child.

`desktop/node-release.json` pins Node **24.13.1 for Windows x64**, matching the
verified installed Node version used for this build. Its executable is an
official Node.js release, verified against `win-x64/node.exe` in the official
[v24.13.1 checksum list](https://nodejs.org/dist/v24.13.1/SHASUMS256.txt):

```text
e3be0545990c90995d7bf3a7af5d64af1f2e0fc1bbd9b79c27f7abc1e9676e50
```

The release descriptor also pins the checksum list itself and the complete
[Node.js redistribution license](https://github.com/nodejs/node/blob/v24.13.1/LICENSE),
including third-party notices. Preparation copies no npm packages, user modules,
configuration files, environment files, account credentials or installed runtime
folders. Only the verified executable, license and source checksum list are staged.

## Prepare release resources

Run from the Nemo repository:

```sh
node scripts/prepare-node-runtime.mjs
```

The default downloads only the exact official pinned URLs over HTTPS, rejects
redirects, bounds download sizes and verifies every digest before writing files.
An operator can instead provide absolute paths to already downloaded or installed
bytes; every input must match the same official pins:

```powershell
node scripts/prepare-node-runtime.mjs --node 'C:\Program Files\nodejs\node.exe' --license 'C:\release-inputs\node-v24.13.1-LICENSE.txt' --checksums 'C:\release-inputs\node-v24.13.1-SHASUMS256.txt'
```

Preparation writes these files under `.work/desktop-runtime`:

```text
node/node.exe
node/LICENSE.txt
node/SHASUMS256.txt
```

It reads and merges the existing top-level runtime manifest, preserving Hermes,
Cloudflared and release settings, and adds:

```json
{
  "node": {
    "file": "node/node.exe",
    "sha256": "e3be0545990c90995d7bf3a7af5d64af1f2e0fc1bbd9b79c27f7abc1e9676e50",
    "version": "24.13.1"
  }
}
```

Do not run independent runtime preparation processes against the same manifest
at once. Coordinate the merge with the Hermes and connector preparation steps.
Use `--out <folder>` for a separately staged release. `--verify` verifies the
prepared files and runs the pinned executable with an empty PATH on Windows.

## Runtime integration and verification

The desktop manifest loader must verify the Node path and digest before accepting
the bundle. Pass that exact resource path as `nodeExecutable` to the Hermes
provider; its MCP configuration uses the bundled executable. Never derive the
child command from `process.execPath` inside Electron or search the parent's PATH.

Run `node --test test/node-bundle.test.mjs`. Tests validate official pins and path
restrictions, copy actual verified release bytes into a temporary path containing
spaces, preserve other manifest fields, detect corruption, and start the real MCP
server with an empty PATH and a synthetic private profile. The smoke test lists
only a granted calendar read tool, successfully reads an empty synthetic calendar,
and rejects an ungranted Gmail tool. It uses no real provider account or network.
Tests that execute the prepared Windows binary skip on other platforms or before
release resources exist; release acceptance must prepare the actual resources and
run them on Windows.

This closes the standalone-Node dependency for connected tool children. It does
not prove that the complete installer works on a clean Windows account; that
still requires the packaged Electron/Hermes/connector and parent setup checks.
