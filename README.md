# Comet Page Reader

Comet Page Reader is a cross-browser WebExtensions add-on that summarises web pages and reads them aloud using your preferred AI provider (OpenAI, Google Gemini, and others). It keeps the API key and request pipeline inside the background service worker so sensitive data never reaches web pages.

## Table of Contents

- [Project Overview](#project-overview)
- [Installation](#installation)
- [Usage](#usage)
- [Architecture & File Structure](#architecture--file-structure)
- [Configuration](#configuration)
- [Testing & Mocking](#testing--mocking)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [Further Reading](#further-reading)

## Project Overview

Comet Page Reader focuses on three responsibilities:

- **Summarise content:** A content script extracts readable text from the current tab, slices it into manageable segments, and forwards them to the service worker.
- **Control usage:** The service worker maintains an internal cache and token tracker, enforcing a configurable monthly token ceiling (defaults to 18,000 tokens via `DEFAULT_TOKEN_LIMIT` in `utils/cost.js`).
- **Deliver an accessible UI:** The popup provides API key management, localisation controls, push-to-talk capture, and audio playback so users can hear the generated summaries immediately.

## Installation

### Prerequisites

- Chrome, Edge, or another Chromium-based browser for day-to-day usage.
- Firefox for parity testing (recommended).
- Node.js 20 or newer and npm when you want to run the automated tests.

### Steps

1. Clone or download this repository: `git clone https://github.com/<your-org>/comet_page_reader`.
2. Generate API credentials for the providers you plan to use and store them securely.
3. Load the extension in your browser:
   - **Chromium (Chrome, Edge, Comet):** open `chrome://extensions`, enable **Developer Mode**, choose **Load unpacked**, and select the repository root.
   - **Firefox:** open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select the repository root (e.g. `manifest.json`).

The extension is fully static, so no bundling step is required. If you plan to execute the test suite, install the dev dependencies once via `npm install`.

### Provider setup

The popup lets you switch between any configured providers at runtime. When running the background worker outside the browser (for example under automated tests) the extension can also read keys from environment variables:

- **OpenAI:** store your key in `OPENAI_API_KEY`.
- **Google Gemini:** store your key in `GOOGLE_GEMINI_API_KEY` (Gemini currently exposes summarisation only; speech features require an audio-capable provider such as OpenAI).

Set the variables in your shell before launching development tooling or rely on the popup to persist the keys in extension storage when testing in the browser.

## Usage

1. Click the Comet Page Reader icon in your browser toolbar to open the popup.
2. Pick an AI **Provider** and paste the matching API key, then press **Save key**. The key lives in background storage only.
3. Select your preferred **Language** (affects summaries and UI text) and **Voice** (used for speech synthesis with providers that support text-to-speech).
4. Choose one of the following interactions:
   - **Summarise page:** Generates summaries for each extracted segment and lists them in the popup.
   - **Read aloud:** Requests speech for the first summary and plays it inside the popup (requires a provider that exposes TTS, e.g. OpenAI).
   - **Push to talk:** Hold the button to dictate commands such as “summary this page” or “read the first result”. Speech-to-text responses automatically trigger matching actions (requires a provider with transcription support).
5. Monitor the **Usage** panel to see cumulative token usage, the configured limit, and the last reset time. Use **Reset token usage** whenever you want to clear historical statistics.

### Programmatic access

While the extension is primarily UI-driven, its utility modules can be imported into tests or tooling thanks to ES module exports. For example:

```javascript
import { createCostTracker, DEFAULT_TOKEN_LIMIT } from './utils/cost.js';

const tracker = createCostTracker(DEFAULT_TOKEN_LIMIT);
tracker.record('gpt-4o-mini', 2000, 500);
console.log(tracker.toJSON());
```

This allows you to reuse the same cost-accounting logic when writing automated tests or companion scripts.

### Command-line usage

Automated tests validate the reusable modules with Node’s test runner. After installing dev dependencies, run:

```bash
npm test
```

The tests execute against a jsdom-powered DOM shim so they can run in any environment that supports Node.js 20+.

## Architecture & File Structure

```
comet_page_reader/
├── background/            # Service worker handling API calls and caching
├── content/               # Content script that extracts and highlights page text
├── popup/                 # Popup UI (HTML/CSS/JS) shown to end users
├── utils/                 # Reusable modules for DOM parsing, cost tracking, audio, i18n, storage
├── tests/                 # Node.js tests that exercise the reusable utility modules
├── docs/DEVELOPMENT.md    # Developer notes, known issues, and maintenance tips
├── manifest.json          # WebExtension manifest configuration
└── package.json           # Dev tooling and test dependencies
```

The [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) guide explains the message flow, how to update localisation strings, and debugging tips.

## Configuration

Key settings are embedded in source files so they remain easy to audit:

- **Token limit:** Adjust `DEFAULT_TOKEN_LIMIT` in `utils/cost.js`.
- **Model selection:** Tweak the defaults in `background/service_worker.js` (chat, transcription, speech synthesis models) if your account prefers alternates.
- **Locales & strings:** Update the `MESSAGES` map inside `utils/i18n.js`.
- **Permissions:** Modify `manifest.json` for additional scopes.

### Free-First Routing

The background worker now routes every generate request through a **free-first router**. Providers are attempted in the order defined by the `routing.provider_order` entry in `agent.yaml` (or the `PROVIDER_ORDER` environment variable), progressing from local/community options through trials and finally paid tiers. If `DISABLE_PAID=true`, the router stops before contacting paid providers and returns `No free providers available and paid disabled.`.

```yaml
# agent.yaml excerpt
routing:
  provider_order:
    - ollama
    - huggingface_free
    - gemini_free
    - openai_trial
    - mistral_trial
    - gemini_paid
    - openai_paid
    - anthropic_paid
  disable_paid: false
  timeout_ms: 20000
  retry_limit: 2
  max_tokens_per_call: 1200
  max_monthly_tokens: 18000
```

The router enforces both per-call and monthly token caps. Override them with `MAX_TOKENS_PER_CALL` / `MAX_MONTHLY_TOKENS` (or the legacy `MAX_COST_PER_CALL_USD` / `MAX_MONTHLY_COST_USD`, which are converted automatically) or by editing the YAML snippet above. Routing can be dry-run with `DRY_RUN=true`, which logs the selection without issuing network calls.

#### Gemini configuration

- **AI Studio (consumer/trial):** provide `GOOGLE_API_KEY`. The router uses the REST endpoint `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`.
- **Vertex AI (enterprise):** set `GCP_PROJECT`, `GCP_LOCATION`, and `GCP_CREDENTIALS` (path to a service-account JSON). Optionally specify `VERTEX_ENDPOINT` to point at a private region or proxy. The adapter exchanges the credentials for an OAuth token and issues requests against `https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent`.

#### Adding a provider adapter

1. Implement an adapter under `background/adapters/your-provider.js` exposing `summarise`, and optionally `transcribe` / `synthesise`.
2. Register it in `background/adapters/registry.js` and add a metadata entry in `background/llm/router.js` (tier, adapter key, API key requirements).
3. Define a configuration block in `agent.yaml` under `providers:` along with an entry in the `routing.provider_order` list.
4. Update tests under `tests/` with success and failure fixtures so the free-first router can route to the new provider reliably.

Quotas and daily caps should be mirrored into `agent.yaml` or environment overrides so the router can skip providers that would exceed their allocation without issuing an API request.

## Testing & Mocking

To exercise the extension without incurring provider costs:

- Switch the `MOCK_MODE` constant in `popup/script.js` to `true` to simulate all background requests.
- Alternatively, point the fetch calls in `background/service_worker.js` to a local mock server (for example `http://localhost:3000`) to return deterministic responses.
- Use your browser’s developer tools to inspect console logs from the popup, background service worker, and content script to verify message flow, caching, and cost tracking.

The ES module structure enables lightweight unit tests. For example, you can import `extractVisibleText` or the cost tracker into Jest and provide DOM shims to validate behaviour without loading the full extension.

## Troubleshooting

- **Debug logging guidance:** Review [docs/debugging.md](docs/debugging.md) for log configuration tips, environment-specific console formats (JSON vs. pretty), correlation-ID tracing, redaction behaviour, and source-mapped stack workflows.
- **Microphone access denied:** The popup’s status area reports permission errors. Grant microphone access in browser settings and retry.
- **Token limit exceeded:** The service worker blocks calls once the configured ceiling is reached. Lower the requested workload, reset usage from the popup, or increase `DEFAULT_TOKEN_LIMIT`.
- **Firefox session storage:** Firefox currently lacks `chrome.storage.session`. The service worker falls back to an in-memory cache which resets per session.
- **No response from content script:** Ensure the site allows content scripts (e.g. some browser pages forbid injections). Refresh the tab and retry.
- **Provider limitations:** Some providers only implement a subset of features. For example, Gemini currently offers summarisation only; choose OpenAI or another audio-capable provider for speech synthesis or transcription.
- **Speech truncated:** Providers such as OpenAI cap text-to-speech inputs (roughly 2,000 tokens). The popup will play a truncated narration when the source exceeds the limit; generate shorter summaries or switch to segment playback to hear the full article.

## Contributing

Pull requests and issues are welcome. Please keep changes modular, portable, and aligned with the privacy expectations above. New features should include accompanying documentation updates.

## Further Reading

- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for developer-oriented notes.
- [MDN WebExtensions documentation](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions) for platform APIs.
