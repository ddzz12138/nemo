# Experimental school-notice design (deferred)

**Not available in the first public release.** Nemo requires a ChatGPT subscription and does not offer local models. The public sidebar hides this workflow and its endpoints reject ChatGPT before reading a Gmail notice. The following records the separate experimental design, not public setup instructions.

The earlier alpha.15 experiment reads one Gmail message chosen by the signed-in person and uses local `gemma4:12b` through guarded Hermes to extract administrative actions. ChatGPT is neither required nor used. It does not solve assessed schoolwork.

## Experimental interaction design

1. Connect your own Gmail in Settings. The host's assistant must be set to local Gemma.
2. Open **School notice** in Nemo's sidebar. Search by the school's sender, subject or a distinctive phrase.
3. Choose one of the five matching previews. Refine the query if the intended message is missing.
4. Select a school year when needed. Approve reading this selected message's text for this local briefing, then choose **Brief selected notice**.
5. Read the result in your chat. Explicit deadlines appear first. Actions include exact supporting quotes and passage citations such as `N1:p2`. Open Activity for the actual read, extraction and validation steps.

This per-task permission does not enable general Connections in chat, automatic Gmail sync or Memory ingestion. The existing Gmail read-only Google grant covers the API operation, but selecting and approving the notice is still required by Nemo. No mail is sent, edited or deleted.

### If Google sign-in fails

The browser callback and the initiating Nemo device show a fixed, safe failure reason. Copy that message rather than the callback URL, authorization code or downloaded client JSON.

Connecting Gmail does not require enabling Memory. A profile with mirroring off, zero recorded copies, and no private Memory mapping or database home skips the unnecessary cleanup step. If a mapping, database home, setup attempt or previous source copies exist, account replacement still requires successful cleanup; an unavailable database is not treated as empty.

- **OAuth client rejected/blocked:** the host checks its Google Desktop client configuration and project restrictions. Existing account grants are preserved when the problem is client configuration.
- **Sign-in code rejected (`invalid_grant`):** begin a new sign-in from Nemo and finish in the browser it opens. A previous callback cannot be replayed. Repeated failures need investigation of the code exchange, including PKCE and the return address; repeating consent alone is not a diagnosis.
- **Sign-in request/return address rejected:** use a Desktop OAuth client for the desktop flow. A Web OAuth client belongs to the separate registered HTTPS flow.
- **Account lookup rejected:** sign-in reached the account lookup step, which Google refused. Check the read-only Gmail permission and any Workspace restrictions.
- **Gmail API disabled:** the host enables the Gmail API in the OAuth client's Google Cloud project.

Upstream descriptions, account details and credentials are never copied into these errors. Completing the local OAuth configuration or passing synthetic tests does not prove a successful real sign-in or school-notice briefing.

## How the system does the work

The typed operation is `school_briefing.v1`. The explicit UI action calls it directly; general natural-language workflow selection and a new MCP routine tool are not added in this milestone. Existing ordinary chat and its read-only MCP tools are preserved.

Code searches headers/snippets, issues a short-lived selection handle, retrieves only the selected message and extracts bounded MIME text. HTML is parsed without executing scripts or fetching images. Attachments and linked pages are not opened. At most 12,000 characters and 48 passages are processed; truncation or unreadable parts produce a partial-result warning.

One fresh, tool-free Hermes session asks Gemma for a small host-pinned JSON schema. The local broker pins the same local model and context settings. Code rejects ungrounded action phrases and quotes, unknown passage references, malformed output and unauthorized fields. It normalizes explicit calendar dates, detects weekday/calendar mismatches, withholds uncertain or revised dates and sorts confirmed deadlines first. It does not invent missing years or create reminders.

These checks establish source matching and bounded interpretation. They do not prove the model found every action or understood every qualification. The briefing states that it covers one message, not the week or whole inbox. Unsupported text, multiple/mixed year groups, ambiguous dates, changed instructions and the six-action limit remain visible limitations. The person should review the quoted evidence before acting.

## Privacy, identity and recovery

- Search handles belong to one server-authenticated profile, expire after ten minutes and bind that Gmail grant. A raw message ID, prompt-supplied identity or another profile's handle cannot select mail.
- The requesting device, profile policy and Gmail permission are rechecked before retrieval, before inference and before saving. Account changes invalidate the selection/result. Children need an owner-granted Gmail capability; the child assistance policy still reaches Hermes.
- Work is persisted in the existing chat/task journal before dispatch. Repeating the same request ID returns the original task; a changed selection/year conflicts. Restart interrupts outstanding work rather than replaying reads or actions.
- The result and supporting quotations stay in that profile's chat history. The full message is not placed in Nemo's normal chat record or GBrain Memory. Automatic conversation learning is skipped for this workflow.
- Hermes extraction uses a private temporary home under the profile. After the child exits, the host verifies its resolved parent and removes that temporary transcript. If cleanup cannot be confirmed, the task reports failure rather than claiming completion. This is ordinary file cleanup, not a guarantee of forensic erasure from the OS, model runtime or backups.
- Existing optional Gmail snippet caches and conversation/backups retain their existing controls and disclosures. Selecting a notice does not change those settings. Active chat deletion also removes that workflow's result through the existing history controls.

## Verification

Run the synthetic application suite with `npm test`. It covers bounded Gmail reads, profile identity, exact evidence, consent, expiry, revocation, account changes and cleanup. The earlier live-local verification script is omitted from the public release. Synthetic library tests remain for future development.

A real user-selected message and physical phone still need separate acceptance. No historical maintainer run establishes the new installer's readiness. Gmail, school-notice briefings and local models are outside the first ChatGPT desktop installation pilot.
