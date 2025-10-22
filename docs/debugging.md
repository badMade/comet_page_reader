# Debugging and Log Analysis

This guide explains how to tune the logging system, interpret structured entries, and trace activity across the Comet Page Reader components.

## Configure log levels

The logger resolves its threshold from (highest priority first):

1. The active logging manifest (`logging_config.yaml`), which you can override or ship alongside the extension.
2. Runtime environment variables (`COMET_LOG_LEVEL`, `LOG_LEVEL`, or `npm_package_config_log_level`).
3. `ENABLE_TRACE`, which forces the threshold to `trace` when set to a truthy value.
4. The default of `info` when no override applies.

Both the background worker and shared Node.js tooling load `logging_config.yaml` automatically; edit the `level` key or supply a JSON/YAML override with `setLoggerConfig` / `loadLoggingConfig` when you need ad-hoc tweaks. When running scripts locally, export `COMET_LOG_LEVEL=debug` (or another supported level) before invoking Node commands to surface additional detail.

## Console formats by environment

Console output adapts to the resolved environment (`ENV`). Production builds emit a single JSON object per line so collectors can parse the data deterministically. Development environments (for example by launching with `NODE_ENV=development` or `COMET_ENV=development`) render the same information in a human-readable string with grouped metadata. Use JSON output for ingestion pipelines and switch to the pretty formatter while diagnosing issues interactively.

## Reading log entries

Every log record contains the following top-level fields:

- `ts`: ISO-8601 timestamp generated at emission.
- `level`: Normalised severity (`fatal`, `error`, `warn`, `info`, `debug`, or `trace`).
- `component`: Logical subsystem (service worker, popup, content script, or script name).
- `msg`: Primary message.
- `context`: Sanitised metadata merged from the logger instance, global context, and any additional values passed to the log call.
- `correlationId`: Optional identifier that links related work across components.
- `env` / `version`: Build metadata captured from the manifest or environment.
- `stack`: Redacted stack trace for captured `Error` objects (suppressed when unavailable).

When the console is in JSON mode, copy the line into a formatter to inspect nested context; in pretty mode, the trailing JSON fragment mirrors the structured payload. File outputs (when enabled via `logging_config.yaml`) always store newline-delimited JSON.

## Following correlation IDs

Each runtime constructs correlation IDs for request/response cycles and attaches them with `withCorrelation`. The helper is available everywhere the shared logger is imported, so you can join IDs across:

- The background service worker (`background/service_worker.js`), which seeds `bg-*` identifiers for provider traffic and propagates them through queued work.
- The popup UI (`popup/script.js`), which generates `popup-*` identifiers for user gestures and forwards them to the background worker.
- The content script (`content/content.js`), which issues `content-*` IDs when relaying DOM extraction events.

To follow an event end-to-end, search for the correlation ID reported in one component’s log across the other consoles. When spawning new work from existing handlers, wrap the new logger in `logger.withCorrelation(currentId)` or merge the helper’s return value into your message payload.

## Redaction behaviour

Sensitive values are automatically removed before emission. Keys containing terms such as `key`, `token`, `secret`, `password`, or `sessionId` are replaced with `[REDACTED]`, and `Error` instances are serialised to safe objects. Stack traces are also scrubbed to drop local paths and URLs, ensuring that logs can be shipped to shared backends without leaking secrets or filesystem structure. If you need full detail locally, inspect the original `Error` object inside developer tools before it is logged or temporarily emit diagnostic data via `debugger` statements.

## Obtaining source-mapped stacks

Because the logger redacts stack locations, rely on runtime tooling for precise source references:

- **Browser:** Open developer tools for the popup, content script, or service worker, enable JavaScript source maps, and reproduce the issue. The modules load directly from their source files (`background/service_worker.js`, `popup/script.js`, and `content/content.js`), so DevTools maps frames to the original lines even when the structured log shows redacted placeholders.
- **Node.js scripts/tests:** Prefix commands with `NODE_OPTIONS=--enable-source-maps` (for example `NODE_OPTIONS=--enable-source-maps node --test`) to make stack traces point to the original ES modules during local runs.

Use these stacks alongside the structured entries to correlate the human-readable frames with the correlation IDs and contextual metadata captured in the logs.
