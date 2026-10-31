# Live task updates and reconnects

Native chat and Tasks use an authenticated server-sent notification stream.
An update prompts the phone to fetch the current private task view. Native text,
waiting labels, questions, checklists, tools and post-reply Memory outcomes share
this path. Reads remain available if streaming is temporarily unavailable.

Each profile has a private bounded change journal. It stores task IDs, sequence
numbers and fingerprints only. It does not copy prompts, replies, email/calendar
contents, tool arguments, reasoning or credentials into another event archive.
Up to 256 notifications can be replayed using a generation/sequence cursor. A
missing, foreign, future or expired cursor requires a fresh authorized task view.
An ordinary page reload also fetches current state before rendering anything.

The stream requires the authenticated device and an explicit matching profile
header. The server rechecks device access at least once a second. Browser code
clears drafts/private views when sign-in changes, closes streams when leaving the
page, pauses them in the background and reconnects with its last in-memory cursor.
It never stores an account token in a URL or uses a prompt-supplied profile.

Reconnection cannot submit a message, answer a question, approve an action or
resume a task. It only replays invalidation notices and reads the saved current
view. After a server restart, uncertain work remains paused. Deleted/undone tasks
invalidate old cursors and are absent from the refreshed projection; cached
notifications cannot recreate their content. Real task and transcript journals
remain authoritative.

Streams last up to 25 seconds before reconnecting, with heartbeats for private
HTTPS proxies, bounded buffering and four simultaneous streams per device (64
globally). Shutdown closes them before waiting for HTTP connections. Slow clients
reconnect and reconcile instead of building an unbounded event backlog.

This is a phone update/recovery channel. It does not expose arbitrary Hermes RPC,
hidden tool payloads, reasoning or upstream request replay. Powerful actions and
their approvals, additional native conversation controls and full isolated workers
are separate unfinished work. Synthetic HTTP and mobile Chrome checks cover
interrupted streams, cursor recovery, profile/device revocation, question drafts,
one-shot answers, deletion and shutdown. Physical iPhone acceptance remains.
