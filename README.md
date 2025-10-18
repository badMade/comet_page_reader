# Comet Page Reader

Comet Page Reader is a cross-browser WebExtensions add-on that summarises web pages and reads them aloud using OpenAI services. It keeps the API key and request pipeline inside the background service worker so sensitive data never reaches web pages.

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
- **Control spend:** The service worker maintains an internal cache and cost tracker, enforcing a configurable spend ceiling (defaults to USD 5.00 via `DEFAULT_LIMIT_USD` in `utils/cost.js`).
- **Deliver an accessible UI:** The popup provides API key management, localisation controls, push-to-talk capture, and audio playback so users can hear the generated summaries immediately.

## Installation

1. Clone or download this repository: `git clone https://github.com/<your-org>/comet_page_reader`.
2. Generate an OpenAI API key and store it securely.
3. Load the extension in your browser:
   - **Chromium (Chrome, Edge, Comet):** open `chrome://extensions`, enable **Developer Mode**, choose **Load unpacked**, and select the repository root.
   - **Firefox:** open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select the repository root (e.g. `manifest.json`).

No additional build steps or package installations are required—the repository ships as a fully static WebExtension bundle.

## Usage

1. Click the Comet Page Reader icon in your browser toolbar to open the popup.
2. Paste your OpenAI API key and press **Save key**. The key lives in background storage only.
3. Select your preferred **Language** (affects summaries and UI text) and **Voice** (used for speech synthesis).
4. Choose one of the following interactions:
   - **Summarise page:** Generates summaries for each extracted segment and lists them in the popup.
   - **Read aloud:** Requests speech for the first summary and plays it inside the popup.
   - **Push to talk:** Hold the button to dictate commands such as “summary this page” or “read the first result”. Speech-to-text responses automatically trigger matching actions.
5. Monitor the **Usage** panel to see cumulative spend, limit, and the last reset time. Use **Reset usage** whenever you want to clear historical costs.

### Programmatic access

While the extension is primarily UI-driven, its utility modules can be imported into tests or tooling thanks to ES module exports. For example:

```javascript
import { createCostTracker } from './utils/cost.js';

const tracker = createCostTracker(10);
tracker.record('gpt-4o-mini', 2000, 500);
console.log(tracker.toJSON());
```

This allows you to reuse the same cost-accounting logic when writing automated tests or companion scripts.

## Architecture & File Structure

```
comet_page_reader/
├── background/            # Service worker handling API calls and caching
├── content/               # Content script that extracts and highlights page text
├── popup/                 # Popup UI (HTML/CSS/JS) shown to end users
├── utils/                 # Reusable modules for DOM parsing, cost tracking, audio, i18n, storage
├── manifest.json          # WebExtension manifest configuration
└── docs/DEVELOPMENT.md    # Developer notes, known issues, and maintenance tips
```

The [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) guide explains the message flow, how to update localisation strings, and debugging tips.

## Configuration

Key settings are embedded in source files so they remain easy to audit:

- **Cost limit:** Adjust `DEFAULT_LIMIT_USD` in `utils/cost.js`.
- **Model selection:** Tweak the defaults in `background/service_worker.js` (chat, transcription, speech synthesis models) if your account prefers alternates.
- **Locales & strings:** Update the `MESSAGES` map inside `utils/i18n.js`.
- **Permissions:** Modify `manifest.json` for additional scopes.

## Testing & Mocking

To exercise the extension without incurring OpenAI costs:

- Switch the `MOCK_MODE` constant in `popup/script.js` to `true` to simulate all background requests.
- Alternatively, point the fetch calls in `background/service_worker.js` to a local mock server (for example `http://localhost:3000`) to return deterministic responses.
- Use your browser’s developer tools to inspect console logs from the popup, background service worker, and content script to verify message flow, caching, and cost tracking.

The ES module structure enables lightweight unit tests. For example, you can import `extractVisibleText` or the cost tracker into Jest and provide DOM shims to validate behaviour without loading the full extension.

## Troubleshooting

- **Microphone access denied:** The popup’s status area reports permission errors. Grant microphone access in browser settings and retry.
- **Cost limit exceeded:** The service worker blocks expensive calls once the configured ceiling is reached. Lower the requested workload, reset usage from the popup, or increase `DEFAULT_LIMIT_USD`.
- **Firefox session storage:** Firefox currently lacks `chrome.storage.session`. The service worker falls back to an in-memory cache which resets per session.
- **No response from content script:** Ensure the site allows content scripts (e.g. some browser pages forbid injections). Refresh the tab and retry.

## Contributing

Pull requests and issues are welcome. Please keep changes modular, portable, and aligned with the privacy expectations above. New features should include accompanying documentation updates.

## Further Reading

- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for developer-oriented notes.
- [MDN WebExtensions documentation](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions) for platform APIs.
