# Start with your family

## Windows desktop preview

1. Open **Nemo** from the Windows Start menu. If updating, quit the old Nemo from
   its menu before running the new installer. Your saved conversations remain.
2. Enter your first name and choose **Set up my assistant**. Hermes and its
   dependencies are included; Nemo prepares them for you.
3. Choose **Continue with ChatGPT**. In the browser, select your account and
   workspace and approve Nemo's connection and use of your ChatGPT plan.
4. Nemo returns to the foreground when ready. Read the plan-use notice and
   choose **Got it**. An eligible existing ChatGPT Plus or Pro plan is required;
   the account's ChatGPT usage and credit settings apply.
5. Choose **Use Nemo on this computer**, confirm your name, then send a message.
   Open **History** to return to the conversation later.

If the browser did not open, choose **Open sign-in again**. If a saved account
needs recovery, choose **Finish connecting my assistant**. If a usage limit is
reached, use **Manage usage** to review ChatGPT settings. Nemo does not require
OpenRouter credits or switch to a different provider automatically.

If Nemo says its assistant files could not be verified, quit Nemo and install
the latest preview, then choose **Set up my assistant** again. Your saved chats
remain on this computer.

The desktop's original phone setup requires its hosted registration service and
domain. A separate opt-in WebRTC phone connection is now available from source
at `/phone-access.html`; its static HTTPS deployment and real-phone acceptance
are still required. See docs/PHONE_ACCESS_SETUP.md. Closing Nemo's window keeps
the host running; choose **Quit Nemo** from its menu to stop it.

## Advanced source/CLI setup

For a manually configured host:

1. Install Node.js 22+ and sign into a compatible Hermes runtime.
2. Run `nemo setup`, `nemo doctor`, then `nemo start`.
3. Configure private HTTPS. With Tailscale, connect the host and phones to the
   same network and configure Serve for Nemo's loopback port.
4. Run `nemo invite` on the host and enter that invitation on your own phone.
5. Open Profile, family & devices to invite members and classify adults/children.
6. Configure your Google Web OAuth app with the exact configured HTTPS origin
   plus `/oauth/gmail/callback`. Import its JSON locally with `nemo gmail FILE`.

For a family member:

1. Open the host's HTTPS address in Safari.
2. Enter your personal invitation and follow `/setup.html` for Home Screen setup.
3. Connect your own Gmail. Choose optional snippet sync separately and review
   whether retrieved information may be used in AI replies.
4. Review/correct facts in Memory. Calendar remains a separate Shortcut snapshot.
5. Open Tasks to see recent replies and stop active work.

The host must stay online. Invitations are single-use; request another to add a
device. Sign out before switching people. Never share account passwords.

This alpha does not enable native full-tool workers, arbitrary PC control or
the planned ten-minute task budget. Those tools remain Needs setup.
