# Family access

Each invitation and passkey belongs to one Nemo profile. Devices signed into the
same person see that person's conversations, connected accounts and Memory.
Changing people requires signing out and authenticating again. Tabs discard
private drafts and cached Nemo state when identity changes.

## Passkeys

After joining with a personal invitation, open Family → Manage your passkeys.
Add a personal passkey using the device's verification prompt. Use Switch person
to sign out, then choose a personal passkey when returning. On a shared operating
system account, choose your own passkey or use your own phone; Nemo cannot tell
which family member unlocked a shared authenticator.

Passkeys require Nemo's configured HTTPS origin. Changing the host name requires
adding passkeys for the new origin. Invitations remain available for recovery.
The host can create a fresh invitation for the same profile without deleting its
data. Removing a key signs out devices authenticated with that key; it preserves
other invitation-paired devices, conversations and Memory.

The private registry stores public keys and verification counters. Private keys
remain with the authenticator or its passkey provider. Challenges expire after
five minutes and can be used once. Profile identity is resolved from the verified
credential, never a submitted profile ID.

## Children

Children start with chat, their own History and Activity. The owner uses Family →
Choose tools for this child to grant individual capabilities. Permission alone
does not enable an unfinished backend: Tools continues to show Needs setup or
Unavailable until that capability works. Existing unclassified members keep
their earlier read access and cannot gain computer tools without classification.

Tool permissions are checked on the server, including after queueing and at the
MCP boundary. Changing them cancels incompatible work and invalidates old tool
contexts and deletion confirmations. Enabling Gmail does not grant access to
another person's account. Connections consent is separate from owner permission.
Memory learning runs only while Memory is permitted. Removing that permission
pauses learning; re-enabling Memory does not silently enable learning again.

Child mode provides tutoring guidance. These features are not comprehensive
parental controls or a guarantee against harmful model output.

## Visible parental review

The owner can enable or disable review for each child. It starts enabled for
child profiles. When enabled, the child sees a notice and a review activity list.
The review screen provides read-only access to main chat, saved native-preview
replies, and active personal Memory facts with their derived summary. Optional
Gmail caches, calendar snapshots and hidden runtime records are not included.
Native-preview entries are saved phone-visible reply projections; they are not a
claim that full native-history migration is complete.

Successful views record the kind of review and time. Disabling review stops new
reads; it cannot retract information the parent already saw. Parent review is a
separate authenticated interface and never supplies child data to the parent's
assistant, search, Memory or tool context. Other adults and children cannot use
it. The application provides no parental-review route into an adult's history.

The host administrator can inspect local files and backups. Profile separation
protects family members through Nemo; it does not hide data from that administrator.

## Verification

Synthetic tests cover private profiles, one-use challenges, revoked passkeys,
exact child tool selections, permission changes during a read, review audits,
source-cache exclusion and denial of adult review. An optional Chrome test uses
a virtual authenticator and the real WebAuthn verifier for registration, sign-in,
two-person switching, child controls and key revocation. Run it with Playwright
available to Node, or set `NEMO_TEST_BROWSER_PACKAGE` to its package manifest and
optionally `NEMO_TEST_BROWSER_CHANNEL=chrome`.

Physical iPhone passkey and cross-device passkey-provider behavior still require
real device checks. No real personal passkeys are created by these tests.
