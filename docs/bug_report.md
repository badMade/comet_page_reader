# Bug Report

## Current Status

- **Resolved:** The `ensureSupportedTab` helper in `popup/script.js` now resolves the tab URL through `resolveSupportedTabUrl` before validation, preventing any `supportedUrl` reference errors. (See `popup/script.js`, lines around 1470-1484.)

## Known Issues

- None currently tracked in this document. Refer to the issue tracker for newly discovered defects.
