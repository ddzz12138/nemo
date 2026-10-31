# ChatGPT plan connection

The first public version requires an eligible ChatGPT subscription. Local-model selection is unavailable. Existing ChatGPT connections are retained across updates; a previous experimental local selection requires explicit ChatGPT opt-in.

The Windows desktop route is **Nemo interface → guarded Hermes agent → the
parent's authorized ChatGPT plan**. It does not require OpenRouter credits or an
OpenAI API key. An eligible existing ChatGPT plan and explicit authorization are
required. Usage remains subject to the account's plan allowance, app limits and
ChatGPT usage settings; this is not a promise of unlimited free inference.

## Parent experience

1. Enter a first name and prepare the bundled assistant.
2. Choose **Continue with ChatGPT**. The system browser opens OpenAI's sign-in.
3. Select an account/workspace and approve ChatGPT plan usage.
4. Nemo returns to the foreground. Confirm the first-use explanation and open local chat. Phone access remains
   unavailable until the separate Nemo registration service is configured.

Eligible replies can use the plan allowance or available ChatGPT credits,
according to the account's usage and credit settings. Nemo cannot override those
provider settings and does not purchase credits or switch billing providers.

The setup window shows the selected account and provides controls to manage
usage, reconnect, change accounts and sign out. The chat composer identifies
ChatGPT plan use without exposing the billing account's identity to other family
members. Nemo history is stored locally; connecting ChatGPT does not import the
user's existing ChatGPT conversations.

## Backend connection

Nemo uses its own dynamic OpenAI client registration, stable host identifier,
loopback callback, PKCE, state and OIDC identity validation. It never borrows a
Codex client ID or reads credentials from another application's auth files.
Protected records retain the issued registration, verified identity, tokens,
expiry and granted permissions. Token renewal runs in the backend. The renderer
and phone never receive OAuth tokens.

The selected account's model catalog supplies the inference model. Catalogs
include lengthy metadata, so this endpoint has a separate 4 MiB response limit;
OAuth and signing-key responses retain their tighter limits. Model metadata is
not copied into prompts or saved with the account. A private
per-run loopback adapter lets the existing guarded Hermes CLI use the official
OAuth Responses route. The adapter sends the authorized model, complete required
context, `store: false` and `stream: true`. Unsupported request fields and
unapproved tools cannot pass through. Only completed inference is a successful
reply. Existing profile isolation, explicit tool permissions and activity
validation still apply.

When ChatGPT is selected, desktop inference requires this connection, including before sign-in and
after sign-out. Ambient API keys and provider fallback settings cannot turn a
missing or exhausted ChatGPT grant into a paid request. The independent native
chat preview remains unavailable in the desktop route until its separate
inference path is adapted; its saved data is preserved.

## Recovery and upgrades

Saved-account recovery can complete model discovery without repeating sign-in.
The UI identifies a saved account separately from a ready connection and waits
for successful startup before showing the first-use plan notice.

Usage limits provide **Manage usage**, opening the fixed ChatGPT usage settings
page. An expired/revoked or ineligible grant provides a clear reconnect or
account-selection message. Raw provider diagnostics never reach the phone.
Pending work is not automatically retried through another provider.

An older OpenRouter connection is not treated as a ChatGPT grant. The user must
connect ChatGPT explicitly. Upgrading preserves conversations, profiles, runtime
home and phone configuration. No real account grant or purchase is performed by
synthetic tests. Live sign-in and a real reply still require manual acceptance
with the account holder present.

## Protocol references

- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [UI and usage guidance](https://developers.openai.com/siwc/ui-ux-guidelines)
