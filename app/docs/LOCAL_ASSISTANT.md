# Local Gemma assistant

Nemo can run ordinary text chat through its guarded Hermes runtime and an existing local Ollama installation. ChatGPT sign-in is optional in this mode. The selected local model is `gemma4:12b`.

## Desktop setup

1. Start Ollama on the same PC. Install the local `gemma4:12b` model in Ollama if it is not already installed. Nemo does not install Ollama or download model weights automatically.
2. Open Nemo and prepare its included Hermes runtime if prompted.
3. Choose **Use local Gemma** in setup or the owner's assistant settings. If selected but unavailable, use **Check Ollama again** after starting Ollama.
4. Open your personal profile and send a text message. The composer identifies local Gemma.

Fresh installations default to local mode. Existing completed/cloud installations keep their previous mode until the host explicitly selects local. Selecting local does not delete ChatGPT grants, chat history, profile Memory or Gmail connections. ChatGPT remains an explicit alternative; a failed local request never switches to it.

For a source/CLI installation, `nemo assistant local` saves the local choice for that installation. Restart its Nemo process to apply it. The choice is stored in the non-secret `assistant-mode.json`; it does not rewrite an external Hermes installation's configuration or credentials.

## Execution boundary

The host verifies that the installed model is a local Gemma GGUF, then starts a capability-protected loopback adapter for each Hermes worker. The adapter forwards only to `http://127.0.0.1:11434/api/chat`, pins `gemma4:12b`, a 65,536-token context, thinking disabled and a 2,048-token output ceiling. It accepts text and the same explicitly permitted read tools; model, endpoint and tool access cannot be selected by a browser or prompt.

Managed worker environment/provider resolution is isolated from ambient cloud keys, proxies and configured provider fallbacks. Inference network access in the guarded Python process is restricted to its local adapter. This process guard is not a general OS sandbox. Separately guarded connector processes still access their permitted services, such as Google, when the profile has enabled them.

Primary chat requests share a bounded serial local-inference queue. Existing post-answer Memory review and embedding scheduling are separate; this milestone does not claim a unified GPU scheduler for every background subsystem.

The adapter validates the complete response before returning text to Hermes; waiting/Activity events remain available. Incremental local token streaming, images, voice and larger autonomous workflows are not added by this change. Length-limited, incomplete or unapproved tool responses fail safely instead of appearing completed. A connection/model failure stays local and offers recovery guidance.

Setup readiness checks read model metadata only. A successful real reply establishes runtime verification; model availability by itself does not prove all tools work. Health checks do not invoke models or read Gmail/calendar contents.

## Verification

- Synthetic unit and integration tests cover pinned routes/settings, denied remote models and tool drift, bounded serial execution, cancellation, preserved cloud grants and setup without credential access.
- Bundled Hermes tests use mocked model responses to verify private conversation resume and the local transport's allowed read-tool protocol.
- The explicit `node scripts/verify-local-chat.mjs --synthetic-live` check calls real local Gemma through an isolated authenticated Nemo profile. It refuses to replace an already resident model, uses no real account/source content and disables Memory learning in that fixture. It is not part of health checks or routine tests.
- The 31 October live functional check returned `LOCAL_NEMO_READY` through Nemo → guarded Hermes → local broker → Ollama, with the actual runner reporting 65,536 context tokens.
- The final 31 October regression run passed 560 tests, skipped 12 optional tests and had no failures; syntax checks passed for 134 JavaScript files. The suite uses synthetic fixtures, not private mail/calendar data.
- The rebuilt desktop executable was activated against the existing Windows NemoData installation. Its own chat listener returned HTTP 200. The separate **Nemo Local** desktop shortcut opens this build; the older installed shortcut was preserved. A real message in Dan's desktop window remains a separate user acceptance check.

For this local build, the executable is `out/Nemo-win32-x64/Nemo.exe`. Keep that build directory intact while using its shortcut. This is a local development build, not a published installer update. Backups of the previous non-secret runtime settings are beside those settings; profiles, conversation records, Memory databases and connected-account grants were not migrated or deleted.

This establishes the approved plan's provider milestone. The subsequent selected-school-notice workflow is described in [School notices](SCHOOL_NOTICES.md); the optional reviewed ChatGPT teaching/import loop remains a later milestone.

## Windows profile-path correction (31 October)

The first real desktop acceptance attempt failed before inference with a tool-policy error. Windows AppData virtualization exposed the same profile directory at a different physical address while the parent root retained its logical address. The guard incorrectly rejected that legitimate alias. A fresh profile without this overlay had passed the earlier functional check, so that check did not cover the installed profile's filesystem behavior.

The guard now accepts this Windows alias only when both addresses identify the same directory file ID and device. Profile and profiles-directory reparse points, foreign profile paths, missing file identity and unmatched directories remain blocked. The original logical root is preserved at the Node MCP boundary. Tool permissions and authenticated profile identity are unchanged.

Verification includes synthetic alias/file-identity cases and existing foreign-path/junction tests, a zero-tool startup check against the affected installation, and a real local Gemma reply through the corrected profile boundary with source-tool execution blocked. Final source regression: 566 passed, 12 skipped, zero failures; 135 JavaScript files passed syntax checks. One earlier run had a Windows temporary-directory cleanup lock; bounded cleanup retries resolved that test failure. The two corrected runtime files were copied into the local desktop build and hash-verified. A successful message in the reopened desktop window remains the user's acceptance check.
