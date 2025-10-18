# Development Guide

This document supplements the main README with implementation details, known issues, and maintenance tips for contributors.

## Environment Setup

1. Install a Chromium-based browser and Firefox for manual testing.
2. Install [Node.js](https://nodejs.org/) 20 or later and run `npm install` in the repository root to fetch the lightweight test dependencies (currently `jsdom`).
3. Clone the repository and load it as an unpacked extension (see README).
4. When debugging, open the following developer tools:
   - **Service worker** console via `chrome://extensions` → inspect views.
   - **Popup** developer tools via right-click → **Inspect** on the popup window.
   - **Content script** console in the active tab.

### Optional tooling

- Use `web-ext` for live reloading in Firefox during development.
- The repository already includes Node's native test runner configuration. You can add Jest or Vitest if you prefer, but the existing `npm test` task runs quickly with no extra setup.

## Code Architecture

The extension is intentionally modular:

- `background/service_worker.js` orchestrates all OpenAI requests, tracks spend using `utils/cost.js`, and mediates messages.
- `content/content.js` extracts visible text and reacts to highlight commands while protecting page integrity.
- `popup/script.js` coordinates UI state, localisation, push-to-talk controls, and background messaging.
- `utils/` houses pure helpers for DOM traversal, storage, audio, localisation, and cost tracking. These modules are designed to be imported into unit tests.

Refer to in-file JSDoc comments for argument and return types.

## Message Flow

1. The content script notifies the service worker whenever page segments change.
2. The popup requests summaries, speech synthesis, or transcription through runtime messages.
3. The service worker responds with summaries, audio, or updated usage information.

## Testing Strategies

- **Mock mode:** Toggle `MOCK_MODE` in `popup/script.js` to simulate successful responses without contacting OpenAI.
- **Local API stubs:** Point `fetchWithAuth` in the service worker to a mock server to experiment with error handling.
- **Unit tests:** Import `utils/dom.js`, `utils/cost.js`, or `utils/audio.js` into a test runner with DOM shims for targeted assertions.
- **Automated checks:** Run `npm test` to execute the Node-based unit tests. The suite boots the background service worker inside a stubbed runtime and exercises DOM utilities via JSDOM.

## Known Issues & Workarounds

- **Firefox session storage:** Firefox lacks `chrome.storage.session`. The service worker already falls back to an in-memory cache; expect cache loss between browser sessions.
- **Microphone permissions:** Browsers may require explicit user approval. Surface errors via the popup status area and prompt users to adjust settings.
- **Long pages:** Extremely long documents may be truncated to keep token usage predictable. Adjust `maxLength` and `minSegmentLength` in `utils/dom.js` if needed.

## Adding Locales

1. Append translations to the `MESSAGES` object in `utils/i18n.js`.
2. Ensure `availableLocales()` includes the new locale (the helper uses the object keys).
3. Update popup HTML select options to include the locale.

## Deployment Checklist

- Increment the version in `manifest.json`.
- Verify API key handling end-to-end on a clean browser profile.
- Reset usage from the popup to confirm storage writes.
- Run through summarise, read aloud, and push-to-talk flows on at least one Chromium browser and Firefox.

