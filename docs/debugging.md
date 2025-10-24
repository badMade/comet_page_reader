# Debugging and Log Analysis

This guide explains how to tune the logging system, interpret structured entries, and trace activity across the Comet Page Reader components.

## Configure log levels

The logger resolves its threshold from (highest priority first):

1. The active logging manifest (`logging_config.yaml`), which you can override or ship alongside the extension.
2. Runtime environment variables (`COMET_LOG_LEVEL`, `LOG_LEVEL`, or `npm_package_config_log_level`).
3. `ENABLE_TRACE`, which forces the threshold to `trace` when set to a truthy value.
4. The default of `info` when no override applies.

The supported levels are `trace`, `debug`, `info`, `warn`, `error`, and `fatal`. Both the background worker and shared Node.js tooling load `logging_config.yaml` automatically; edit the `level` key or supply a JSON/YAML override with `setLoggerConfig` / `loadLoggingConfig` when you need ad-hoc tweaks. When running scripts locally, export `LOG_LEVEL=debug` (or its alias `COMET_LOG_LEVEL=debug`, both accepted by `utils/config.js`) before invoking Node commands to surface additional detail, for example:

```bash
LOG_LEVEL=debug npm test
```

You can also set `ENABLE_TRACE=true` (or toggle the manifest field) to momentarily unlock verbose trace entries without editing the log level directly.

## Console formats by environment

Console output adapts to the resolved environment (`ENV`). Production builds emit a single JSON object per line so collectors can parse the data deterministically. Development environments—triggered by setting `COMET_ENV=development`, `NODE_ENV=development`, or the equivalent manifest flag—render the same information in a human-readable string with grouped metadata. Use JSON output for ingestion pipelines and switch to the pretty formatter while diagnosing issues interactively; you can always recover the original JSON payload from the trailing fragment of the pretty log line.

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

### Example structured entry

```json
{
  "ts": "2024-03-06T19:48:12.519Z",
  "level": "info",
  "component": "background.service_worker",
  "msg": "Provider response cached",
  "correlationId": "bg-9af2c6",
  "env": "production",
  "version": "1.2.3",
  "context": {
    "meta": {
      "provider": "openai",
      "tokensUsed": 742
    }
  },
  "stack": null
}
```

The `context.meta` object aggregates any supplemental key-value pairs you passed when logging. Search for the `correlationId` across consoles or log files to follow a request through every runtime.

## Following correlation IDs

Each runtime constructs correlation IDs for request/response cycles and attaches them with `withCorrelation`. The helper is available everywhere the shared logger is imported, so you can join IDs across:

- The background service worker (`background/service_worker.js`), which seeds `bg-*` identifiers for provider traffic and propagates them through queued work.
- The popup UI (`popup/script.js`), which generates `popup-*` identifiers for user gestures and forwards them to the background worker.
- The content script (`content/content.js`), which issues `content-*` IDs when relaying DOM extraction events.

To follow an event end-to-end, search for the correlation ID reported in one component’s log across the other consoles. When spawning new work from existing handlers, wrap the new logger in `logger.withCorrelation(currentId)` or merge the helper’s return value into your message payload.

### Browser fallback limitations

Browser runtimes rely on a cooperative fallback when `AsyncLocalStorage` is unavailable. The helper tracks scope on a single token tied to the active call stack, which means overlapping `await` chains (for example, multiple parallel fetches) can overwrite one another’s context. When you need strict isolation in the browser, avoid interleaving awaits on the same logger instance or include correlation data explicitly in each log payload.

#### Example: overlapping async scopes

```javascript
import { createLogger } from "utils/logger.js";

const logger = createLogger();

async function taskOne() {
  await fetch("/api/task-one");
  logger.info("task one finished");
}

async function taskTwo() {
  await fetch("/api/task-two");
  logger.info("task two finished");
}

// ❌ Context from `taskTwo` can leak into `taskOne` when the await chains overlap.
await Promise.all([
  logger.wrapAsync(taskOne, { id: 1 })(),
  logger.wrapAsync(taskTwo, { id: 2 })(),
]);
```

Use one of the following strategies when you need deterministic scope isolation:

```javascript
import { createLogger } from "utils/logger.js";

// Using the same taskOne/taskTwo definitions from above.
async function runWithSeparateLoggers(taskOne, taskTwo) {
  const loggerOne = createLogger();
  const loggerTwo = createLogger();

  // ✅ Independent loggers maintain separate scope tokens.
  await Promise.all([
    loggerOne.wrapAsync(taskOne, { id: 1 })(),
    loggerTwo.wrapAsync(taskTwo, { id: 2 })(),
  ]);
}

async function runWithCorrelation(taskOne, taskTwo) {
  const logger = createLogger();

  // ✅ Explicit correlation data keeps entries distinguishable.
  await Promise.all([
    logger.wrapAsync(taskOne, { correlationId: "task-1" })(),
    logger.wrapAsync(taskTwo, { correlationId: "task-2" })(),
  ]);
}
```

## CLI exception hooks and exit codes

Node-based utility scripts under `scripts/` register shared exception hooks (via `registerCliErrorHandlers`) so failures emit predictable, structured output. The helper wires `process.on('uncaughtException')` and `process.on('unhandledRejection')` to a logger configured with `component: "cli"` and the script name in `context.script`. Each handler derives a correlation ID from `COMET_CLI_CORRELATION_ID`, `COMET_CORRELATION_ID`, or `CORRELATION_ID` when present; otherwise it generates a single `cli-<script>-*` identifier for the entire process and appends the event name (for example `:uncaught-exception`). The metadata sent to the logger flows through the normal sanitisation rules, so sensitive keys on either the error or rejection reason are redacted automatically before the JSON line is flushed.

After logging the fatal entry the helper sets `process.exitCode` (default `1`), includes the resolved `exitCode` in the structured payload, and schedules a hard exit. This gives downstream tooling a deterministic sequence: a final JSON log entry with the fatal message and exit code, followed by Node terminating. Because the helper waits until the logger promise settles before forcing the exit, collectors reliably ingest the record even when the script fails mid-stream. Supply a correlation ID explicitly (`COMET_CLI_CORRELATION_ID=preflight npm run verify:npm-registry`) when you want to stitch the script lifecycle into a broader workflow trace.

## Redaction behaviour

Sensitive values are automatically removed before emission. Keys containing terms such as `key`, `token`, `secret`, `password`, or `sessionId` are replaced with `[REDACTED]`, and `Error` instances are serialised to safe objects. Stack traces are also scrubbed to drop local paths and URLs, ensuring that logs can be shipped to shared backends without leaking secrets or filesystem structure. If you need full detail locally, inspect the original `Error` object inside developer tools before it is logged or temporarily emit diagnostic data via `debugger` statements.

## Obtaining source-mapped stacks

Because the logger redacts stack locations, rely on runtime tooling for precise source references:

- **Browser:** Open developer tools for the popup, content script, or service worker, enable JavaScript source maps, and reproduce the issue. The modules load directly from their source files (`background/service_worker.js`, `popup/script.js`, and `content/content.js`), so DevTools maps frames to the original lines even when the structured log shows redacted placeholders.
- **Node.js scripts/tests:** Prefix commands with `NODE_OPTIONS=--enable-source-maps` (for example `NODE_OPTIONS=--enable-source-maps node --test`) to make stack traces point to the original ES modules during local runs.

Use these stacks alongside the structured entries to correlate the human-readable frames with the correlation IDs and contextual metadata captured in the logs.
