# Private native conversations

History now shows each profile's main-chat and native conversations together.
Search matches words in that profile's saved display text locally. Viewing,
searching, importing, branching, undoing and deleting do not run a model or read
Gmail, Calendar or personal Memory.

Native transcripts are stored by Hermes in the profile's private home. Nemo's
`native-history.json` is a presentation cache and stable mapping journal, not a
second provider transcript. Native messages are read through the session protocol;
system scaffolding, raw tools, reasoning and arbitrary metadata are excluded.

## Import and continuity

“Import earlier chats” processes up to twenty idle conversations per request and
continues until the current batch is complete. It saves a private immutable
message backup first. Existing pairing, Gmail consent and Memory are unchanged.
Only that profile's Nemo chats are eligible; shared historical Hermes records are
never imported into every family member.

Each import has a durable UUID and private runtime title. A repeat/lost create
acknowledgement is reconciled by this title, including across worker restarts;
Hermes's own create idempotency cache alone is process-local. Deleted mappings are
retained as empty tombstones and cannot be imported again. If main chat changes
after an import, its newer copy remains visible separately until cutover.

Native chat supports multiple conversations and continuation from History. A
change to Connections starts a separate conversation. Older source-bearing
conversations remain readable to their owner but cannot be resumed under a new
account or consent scope. Imported legacy chats whose source provenance is unknown
are read-only; they do not silently become connected context.

The main CLI chat still exists as a separate rollback bridge. This revision does
not silently change the default chat engine or import all profiles at startup.

## Controls and recovery

- Rename affects the phone title only; a stable internal title preserves recovery.
- Branch copies native history into a separately mapped conversation. Stable
  action IDs prevent an interrupted create from making duplicate branches.
- Undo previews the exact last user turn and fences its revision. The journal
  records the change before dispatch. After an interrupted acknowledgement, a
  native transcript comparison determines whether it applied; Nemo never blindly
  repeats undo. Undo is not privacy deletion: Hermes may retain inactive rows.
- Delete previews the conversation and retains an exact receipt for all native
  compression records and delegated children. Fingerprints are checked inside the
  SessionDB write transaction. Explicit copied branches remain separate. Nemo
  verifies native transcript files are gone before reporting success, because the
  upstream best-effort file sweep can otherwise ignore errors.
- Active native tasks are excluded from History mutations. Stale, expired,
  changed and foreign-profile confirmations are rejected. Pending deletions cannot
  be used for new work; a retry reconciles the original saved receipt.
- Task display text/Activity are removed with the conversation. Minimal request
  fingerprints remain to reject a replay of a deleted submission.

Deleting an imported conversation also retires its unchanged original Nemo copy.
If the original acquired newer turns, Nemo reports incomplete deletion and exposes
the changed original for separate review. Saved Memory and migration backups are
separate. Legacy shared Hermes records, host backups and diagnostic logs are not
claimed to be securely erased by this control. The host administrator can inspect
local storage.

## Verification

Synthetic checks cover conflicting profiles, private search, import repetition,
branching, stale confirmations, deletion tombstones, lost acknowledgement recovery
and mobile navigation. The installed Hermes engine is tested in a temporary
synthetic home with inference deliberately unavailable. It verifies imports,
branching, undo, compression continuation deletion and sibling preservation.
These checks do not establish physical iPhone acceptance or macOS verification.
