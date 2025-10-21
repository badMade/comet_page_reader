# Bug Report

- **File:** `popup/script.js`
- **Location:** `ensureSupportedTab` function around line 1047
- **Description:** The function references an undefined variable `supportedUrl`, triggering a `ReferenceError` when `ensureSupportedTab` runs. This occurs when `readFullPage` validates the active tab prior to sending messages.
- **Impact:** Popup actions that rely on `ensureSupportedTab`, such as reading the full page, fail immediately with a runtime error. Users cannot invoke the feature on supported pages.
- **Fix Plan:** Update `ensureSupportedTab` to resolve the supported URL via `resolveSupportedTabUrl`, validate it, and return a normalised tab object without referencing undefined identifiers. Add regression coverage ensuring tabs with pending URLs are handled without raising errors.
