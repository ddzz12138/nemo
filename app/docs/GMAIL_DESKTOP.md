# Gmail in the Nemo desktop app

In **Settings → Your connections**, choose **Connect Gmail**. Google opens in
your system browser. Choose your account, approve read-only Gmail access, then
return to Nemo. Settings updates automatically. You can cancel, change accounts
or disconnect there. Gmail is optional; it never blocks chat or first setup.

Family members do not create Google Cloud projects, import JSON, enter passwords
into Nemo, or configure callback addresses. Each allowed profile connects its
own account. The family owner’s role does not expose another adult’s Gmail.

## Storage and permission

- A random loopback callback, state and S256 PKCE bind each sign-in to the
  initiating authenticated profile/device. The flow expires after five minutes.
- Credentials use the existing protected profile store on the home PC (Windows
  DPAPI). No tokens or authorization URLs pass through the renderer.
- Logout, device revocation, profile disabling, disconnect and cancellation
  invalidate pending sign-in. A cancelled account change preserves the old grant.
- New desktop connections use on-demand access. They do not enable background
  email caching or the separate **Use my connected accounts** permission.
- Nemo reads bounded metadata/snippets, not attachments, and cannot send or
  modify email. When that profile enables connected accounts, relevant email
  context may reach ChatGPT to answer a request.
- The existing phone Web OAuth path is retained. Desktop sign-in does not need
  its Web client, private HTTPS address, phone invitation or VPN.

## Publisher configuration

The release includes `desktop/google-oauth.json`, containing only a public Google
Desktop application client ID. Startup installs that public configuration into
a new home’s shared configuration directory. Existing operator configuration
and account grants are preserved.

To change the publisher client, the developer explicitly selects a Desktop JSON:

```powershell
node scripts/configure-google-publisher.mjs --client C:/private/desktop-client.json
```

The helper copies only `client_id`. It refuses Web client files; client secrets
and user tokens never enter the release configuration. OAuth endpoints are fixed
in code, and redirects are never followed during Google credential requests.

Nemo’s publisher still maintains the Google application and any required
verification. `gmail.readonly` is a restricted scope. This implementation and its
synthetic tests do not establish Google production verification or successful
authorization by a real account. A testing-mode project may admit only its
configured testers. See Google’s [desktop OAuth guidance](https://developers.google.com/identity/protocols/oauth2/native-app)
and [Gmail scope reference](https://developers.google.com/workspace/gmail/api/auth/scopes).
