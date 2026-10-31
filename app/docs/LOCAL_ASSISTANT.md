# Local models: deferred from the first public release

The public Nemo app requires an eligible ChatGPT subscription. It does not install, download, discover or offer local AI models. The earlier local Gemma setup and `nemo assistant local` selection are not supported in this release. Use **Continue with ChatGPT** in Nemo setup.

Existing ChatGPT accounts and profile data are preserved. If an older experimental build selected local inference, Nemo waits for the owner to explicitly connect ChatGPT; it does not silently reactivate a saved cloud grant.

Local transport and model-dependent workflow modules remain as development groundwork with isolated synthetic tests. They are not enabled by the public desktop/server entry points. Automatic GBrain review/embeddings, School notice and the alternative-provider native preview are deferred. Existing experimental stores remain on disk; Gmail account changes are blocked when their prior Memory copies cannot be safely cleaned up.

Ollama attribution concerns the desktop interface provenance, not an inference requirement. See [ChatGPT connection](CHATGPT_PLAN.md).
