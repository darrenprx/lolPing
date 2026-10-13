# AI assistance contribution notes

This branch adds opt-in, per-signal screenshot assistance to lolPing. It is intentionally kept separate from PingForAI branding so it can be reviewed as an upstream feature.

- Configure an HTTPS OpenAI-compatible vision chat endpoint and API key in Settings → AI assistance.
- Each ping can independently ask the model to explain, copy, show-and-copy, or do nothing.
- The request sends a high-detail crop around the ping first and a same-display overview second. The prompt tells the model to prioritize nearby content (approximately 80%) and use the overview only for context (approximately 20%).
- AI answers render as sanitized Markdown in a persistent window that the user closes manually.
- API keys are stored with Electron `safeStorage`; enabled signals disclose that the current display is uploaded to the configured provider.

This branch requires a maintainer review of the provider support, privacy wording, and UX before merging.

Validation: TypeScript checks and the production build pass. Vitest reports 725 passed and 1 skipped across 48 files with `--maxWorkers=2 --testTimeout=20000`. The original helper build targets arm64; on the Intel test host its same sources were compiled locally for x86_64 to run protocol tests, without changing release targets. The related implementation was smoke-tested in a real Electron 37 window for Markdown, sanitization, persistence, copying, and manual closing. No new live provider request was performed for this contribution branch.

Current limitations: the analysis instruction and answer controls use Chinese; other app settings remain localized. Provider/model support must be checked by the user, and Windows/packaged arm64 execution has not been verified on this host.
