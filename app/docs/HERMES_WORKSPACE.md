# Hermes skills and tools in Nemo

The source build includes **Hermes workspace** in the owner's sidebar. It uses
the pinned Hermes gateway, agent, native tool registry, skill loader, approvals
and delegation implementation. Nemo supplies the interface and ChatGPT account
adapter. Vendored Hermes source and tool/skill implementations are unchanged.

Open Nemo on the home computer as the owner and choose **Hermes workspace**.
Choose **Prepare browser and computer tools** for their initial native package
setup, then **Open Hermes workspace**. Downloads and integrity checks use
Hermes's own package manager. Ask Hermes to list its skills or perform a task.
Approval cards preserve the choices Hermes offers for that exact action. Secret
and password requests use masked fields and are not stored in Nemo's displayed
conversation. Stop Hermes before returning to regular chat or editing Memory.

This workspace runs with the owner's operating-system access. It is available
only through a direct local owner connection, not child/member profiles, phone
connections or a public tunnel. Family chat keeps its existing scoped tools and
permissions. Signing out or revoking the controlling device stops the workspace.

The included audited skill set is loaded through Hermes's own skill sync. This
does not add optional third-party skill packs. Tools still follow Hermes's own
dependency checks: browser/computer/media integrations can need additional
software, an account or a supported platform. The availability display uses the
actual agent's session information; a name existing in its catalog is not proof
that its dependencies are configured.

The workspace uses the same private Hermes notes as the owner's Memory screen.
Its conversation is stored by Hermes and restored when reopening the workspace;
it remains separate from regular Nemo chat History. Stopping never resubmits an
uncertain tool action. An unsuccessful shutdown stays busy until Stop succeeds.

## Test the source build without replacing installed Nemo

From PowerShell in the repository root:

```powershell
cd app
npm run desktop:interface:build
npm run preview:assistant
```

Open the private setup link printed by the command. This trial has its own data
under `app/.work/assistant-preview` and uses port 8795. Create a test profile,
prepare the included assistant and connect your ChatGPT account. The preview uses a separately prepared tools runtime when its verified ready
marker exists; otherwise it uses the staged candidate runtime. Prepare a fresh
checkout with `npm run desktop:prepare:candidate` first. If you already have an
older staged runtime, run `npm run prepare:hermes-workspace` once before
previewing. New candidate builds include the package-manager environment. Your installed
Nemo and its data are not replaced or copied. Your ChatGPT plan limits apply.
Keep the command running; Ctrl+C stops this preview.

To check automatic memory:

1. In regular chat, say: “Remember for this test: my imaginary cat is Mango.”
2. Open **Memory** and check that the saved detail appears.
3. Choose **New Chat** and ask: “What is my imaginary cat called?”
4. Forget the saved detail in Memory, then inspect Memory to verify removal.
   Earlier conversations remain and can teach the detail again if reused.

To check native skills/tools, open Hermes workspace and ask “Show your available
skills.” Use a harmless test task first. Its exact tool availability depends on
this computer's setup, as in Hermes itself. This source preview is not a signed
installer or proof of every browser/computer integration on a real device.
