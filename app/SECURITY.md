# Security

The explicit local-owner Hermes workspace runs the unchanged upstream gateway
with the owner's OS access. It is not a profile sandbox. Its HTTP controls reject
members, children, remote/tunnel hosts and phone-link dispatch; profile/device
authorization is rechecked during execution. Native approvals remain Hermes's
own. Ordinary family chat keeps its separate restricted worker. See
[Hermes workspace](docs/HERMES_WORKSPACE.md) for its scope and testing.

Nemo is an independent companion for Hermes. Host administrators can inspect
local storage. Profile separation does not hide data from the administrator.

Keep Nemo on loopback behind authenticated private HTTPS. Do not expose the
agent port directly to the Internet. An approved chat user is not automatically
authorized to use another person's connected accounts or host files.

Do not submit credentials, real mail, calendar contents, database dumps, private
URLs or unredacted logs in public issues. Report suspected vulnerabilities
privately through the repository's security reporting channel once enabled.
Until that channel exists, do not publish exploit details in an issue.

Family workers must not expose advanced tools without tested execution boundaries
and approval enforcement. A profile directory alone is not an operating-system
sandbox. Existing guarded CLI sessions are not isolated OS workers. The explicit
local-owner workspace instead uses the owner's OS access and native Hermes
approvals, as described above.

Ordinary family ChatGPT-only sessions use a separate Hermes home per authenticated Nemo
profile. Only the pinned native memory tool and permitted read-only connections
are admitted through the guard and subscription broker. The Memory interface
operates on those same native files, with ownership/revision checks and explicit
confirmation for deletion. Unreadable stores and incomplete source-copy cleanup
fail closed; no global-memory or alternative-provider fallback is allowed.

Memory is automatic. Relevant stored notes are sent with ChatGPT requests, and
memory decisions use that plan. Forget/clear does not erase History, originals,
backups or previous provider context, and does not promise that a detail can
never be learned again. Local administrator access still applies.

No telemetry is collected by default. Diagnostic commands check readiness
without triggering model inference or reading connected-account content.
