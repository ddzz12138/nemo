# Security

Nemo is an independent companion for Hermes. Host administrators can inspect
local storage. Profile separation does not hide data from the administrator.

Keep Nemo on loopback behind authenticated private HTTPS. Do not expose the
agent port directly to the Internet. An approved chat user is not automatically
authorized to use another person's connected accounts or host files.

Do not submit credentials, real mail, calendar contents, database dumps, private
URLs or unredacted logs in public issues. Report suspected vulnerabilities
privately through the repository's security reporting channel once enabled.
Until that channel exists, do not publish exploit details in an issue.

Advanced tools must remain unavailable until their execution boundary and
approval enforcement have passed adversarial tests. A profile directory alone
is not an operating-system sandbox. Existing guarded CLI sessions are not the
planned native, isolated workers.

No telemetry is collected by default. Diagnostic commands check readiness
without triggering model inference or reading connected-account content.
