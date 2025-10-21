# Development Guide

This document supplements the main README with implementation details, known issues, and maintenance tips for contributors.

## Environment Setup

1. Install a Chromium-based browser and Firefox for manual testing.
2. Install Node.js 20+ and run `npm install` to fetch the optional dev dependencies (currently `jsdom` for DOM-focused unit tests).
3. Clone the repository and load it as an unpacked extension (see README).
4. When debugging, open the following developer tools:
   - **Service worker** console via `chrome://extensions` → inspect views.
   - **Popup** developer tools via right-click → **Inspect** on the popup window.
   - **Content script** console in the active tab.

### Optional tooling

- Use `web-ext` for live reloading in Firefox during development.
- Run `npm test` (Node’s built-in test runner) to execute the utility tests under jsdom.
- Employ Jest or Vitest with `jsdom` if you want more elaborate automated tests around the modules in `utils/`.

## Code Architecture

The extension is intentionally modular:

- `background/service_worker.js` orchestrates provider requests (OpenAI, Gemini, and others), tracks token usage using `utils/cost.js`, and mediates messages.
- `content/content.js` extracts visible text and reacts to highlight commands while protecting page integrity.
- `popup/script.js` coordinates UI state, localisation, push-to-talk controls, and background messaging.
- `utils/` houses pure helpers for DOM traversal, storage, audio, localisation, and usage tracking. These modules are designed to be imported into unit tests.

Refer to in-file JSDoc comments for argument and return types.

## Message Flow

1. The content script notifies the service worker whenever page segments change.
2. The popup requests summaries, speech synthesis, or transcription through runtime messages.
3. The service worker responds with summaries, audio, or updated usage information.

## Testing Strategies

- **Mock mode:** Toggle `MOCK_MODE` in `popup/script.js` to simulate successful responses without contacting any provider.
- **Local API stubs:** Point `fetchWithAuth` in the service worker to a mock server to experiment with error handling.
- **Unit tests:** Import `utils/dom.js`, `utils/cost.js`, or `utils/audio.js` into a test runner with DOM shims for targeted assertions.

### Provider specifics

- **API keys:** When running scripts outside the browser, export `OPENAI_API_KEY` or `GOOGLE_GEMINI_API_KEY` (and any other provider-specific variables listed in `agent.yaml`) so the service worker can authenticate without prompting.
- **Gemini:** The Gemini adapter focuses on summarisation; it throws descriptive errors for transcription or speech synthesis requests. Surface these to users or choose a provider with audio endpoints (e.g. OpenAI) when enabling push-to-talk or read-aloud features.

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

