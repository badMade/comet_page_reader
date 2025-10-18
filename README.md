# Comet Page Reader

Comet Page Reader is a cross-browser WebExtensions add-on that summarises web pages and reads them aloud using OpenAI services. It runs on Chrome, Edge, Firefox, and Comet, keeping the OpenAI API key inside the extension service worker and funnelling all network traffic through a single secure location.

## Features

- **Secure background service worker** that stores the API key in `chrome.storage.sync` with Firefox fallbacks and enforces a configurable spend ceiling (defaults to USD 5.00 via `DEFAULT_LIMIT_USD` in `utils/cost.js`).
- **Content intelligence** provided by a modular content script that extracts visible text, segments long pages, and responds to highlight or refresh requests.
- **Popup dashboard** with API-key management, language and voice selectors, push-to-talk capture, audio playback controls, usage tracking, and a privacy disclaimer.
- **Utility modules** for DOM parsing, localisation, cost accounting, and audio capture/playback to ensure the codebase stays maintainable and testable.
- **Caching layer** keyed by URL/segment to avoid unnecessary OpenAI calls and keep running costs predictable.

## Installation

1. Clone or download this repository.
2. Create an OpenAI API key and keep it handy.
3. Load the extension in your browser:
   - **Chromium (Chrome, Edge, Comet):** open `chrome://extensions`, enable Developer Mode, choose **Load unpacked**, and select the repository root.
   - **Firefox:** open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select the repository root.

The extension registers its popup automatically and will request permissions for storage, tabs, activeTab, and scripting on first run.

## Configuration & Usage

1. Open the popup from the browser toolbar.
2. Paste your OpenAI API key and press **Save key**. The key is persisted in the background worker only.
3. Pick a preferred language (for summaries and UI strings) and a voice preset.
4. Use **Summarise current page** to request section-by-section summaries from the background worker.
5. Press **Read highlighted segment** to generate speech for the first summary. The player controls support play, pause, and stop.
6. Hold **Push to talk** to dictate commands; releasing the button triggers speech-to-text transcription. Commands containing “summary” trigger summarisation, and commands with “read” trigger playback automatically.
7. Review the usage dashboard for real-time cost tracking and reset the cycle when required.

## Privacy & Security

- API keys are stored with WebExtensions storage APIs and never injected into content pages.
- All network traffic to OpenAI originates from the service worker, which validates cost ceilings before executing requests.
- Page content is processed in-memory only for the duration of the request. Summaries are cached per URL/segment in session storage to minimise repeated uploads.
- The popup displays a clear disclaimer reminding users that content is transmitted to OpenAI.

## Testing Without Live APIs

To exercise the extension without incurring OpenAI costs:

- Replace the endpoints inside `background/service_worker.js` with a local mock server (e.g. using `http://localhost:3000`) that echoes deterministic responses. Because all network calls originate from the service worker, only a single URL needs to change.
- Alternatively, stub the `sendMessage` calls in `popup/script.js` with mock responses by uncommenting the sample `MOCK_MODE` snippet in that file (placeholder hooks are provided near the top of the file for quick toggling).
- Use browser devtools to inspect console logs from the popup, background worker, and content script to confirm message flow, caching, and cost tracking.

Automated browser integration tests are not bundled, but the code is structured into small, easily testable modules (`utils/` directory) so you can import them into your preferred test runner without the extension runtime. For example, you can unit test `extractVisibleText` or the cost tracker using Jest by providing minimal DOM shims.

## Troubleshooting

- If microphone access is denied, the popup will display the error in the status region. Grant the permission in browser settings and retry.
- Cost-limit breaches return actionable error messages from the background worker; reset usage or raise the configured limit in code before reattempting.
- Firefox currently lacks `chrome.storage.session`; the service worker falls back gracefully and keeps cache data in-memory.

## Contributing

Pull requests and issues are welcome. Please ensure additions remain modular, portable, and respectful of the privacy guarantees outlined above.
