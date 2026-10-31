# Questions and checklists

Native chat reuses Hermes's `clarify` and `todo_list` implementations. These are
conversation features: they do not grant access to an inbox, source cache, files,
terminal, browser, purchases or external actions. They also work in child chat
without granting any connected tool. The child tutoring instruction remains active.

A task may show a question card with choices, free text, multiple selections or
explicit skipping. No choice is submitted automatically. Questions expire after
five minutes. A submitted answer is recorded before waiting for a cloud slot, so
it does not expire while the server is busy. Waiting for a human or a cloud slot
does not consume the task's ten active minutes. The cloud slot is released while
Hermes waits; another profile can keep working.

Only a paired device in the originating profile can answer. The coordinator maps
the public card to the exact live native request. Answers are one-shot; a repeated
identical answer is acknowledged without sending it again, and changed or stale
answers are rejected. An ordinary answer such as “yes” or “once” is never an action
approval. Powerful action tools and their approval interface remain separate work.

Checklists show real native revisioned state, including pending, in-progress,
completed and cancelled items. They are persisted with the originating task and
remain visible after reconnecting. Source results and private reasoning do not
become Activity. Actual native interaction starts/completions have their own safe
Activity labels. Both question and checklist calls share the task's 64-call budget.

The worker's exact tool schemas and handlers are pinned and rechecked. Whole
batches are validated before execution. Native interaction calls require admission
through the task-bound host broker even though their bodies contain no source
data. They do not bypass profile or budget checks via an inline Hermes executor.

Unanswered cards are closed on stop, policy/device revocation, expiry or restart.
A restart never replays a model prompt or an old answer. Follow-up answers are
retained as private card history (up to sixteen earlier cards in the task view),
and conversation deletion/undo removes their task presentation data as well as
the associated native transcript. Saved Memory remains separate.

The phone UI preserves typed answers during polling, clears drafts when leaving
the profile, handles multi-device answer races, and keeps a stopped/expired task
distinct from completed work. New conversations require the current reply to
finish or be stopped, so work is not orphaned behind an empty chat.

Stopping the server fences both new worker starts and workers that finish starting
late. Shutdown waits for those processes to exit before releasing their journals.
The generated private configuration explicitly keeps turn execution in this
guarded worker; it cannot start an unguarded compute subprocess.
Automatic upstream title inference is off. Nemo owns the visible title and the
stable native mapping; completing a reply must not schedule another provider call
outside that task merely to rename its transcript.

Verification uses synthetic data only: the installed Hermes engine runs its real
native clarify callback and checklist store against a local fake provider. Mobile
Chrome covers typing, answering, persisted cards/plans, reconnect and profile
switching. Physical iPhone and macOS acceptance remain outstanding.
