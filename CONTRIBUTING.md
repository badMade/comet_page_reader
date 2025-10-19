# Contributing to Comet Page Reader

Thank you for considering a contribution! This project powers the Comet Page Reader browser extension, which extracts page content, segments it, and generates spoken summaries with pluggable AI providers. The guidelines below help keep the codebase consistent, testable, and portable across environments.

## Project Architecture

The summarisation workflow is built around two complementary layers:

1. **Adapters** (see `background/` and `utils/`): provider-specific modules that translate the unified prompt/response shape into API calls. Adapters handle endpoint URLs, headers, authentication, and response parsing.
2. **Strategies** (mainly in `background/service_worker.js` and `content/` scripts): provider-agnostic orchestration that coordinates page segmentation, prompt selection, cost tracking, and playback.

Adapters expose a common interface so that strategies can request summaries without being tightly coupled to any single provider. Shared configuration (prompts, runtime defaults, and environment variables) lives in repository root files such as `.prompt.yml`, `agent.yaml`, and `.env.example`.

## Adding a New Provider

Follow these steps to wire in an additional provider:

1. **Configuration**
   - Add an entry to `agent.yaml` with the provider name, default model, API URL, temperature, and the environment variable that stores the key.
   - Document the provider-specific API key in `.env.example`, mirroring the existing variables.
   - If custom prompts are required, extend `.prompt.yml` with provider-specific blocks or keys.

2. **Adapter Implementation**
   - Create a new module under `background/` (or extend an existing adapter directory) that implements the shared adapter interface:
     - Load the API key via `process.env[api_key_var]` (or the Chrome equivalent when running inside the extension).
     - Build the request payload using the shared prompt structure.
     - Parse the response into the standard summary format expected by the strategy layer.
   - Keep the adapter pure: avoid global mutations, close over only what you need, and surface errors clearly.

3. **Strategy Wiring**
   - Update the orchestration logic to select the adapter based on `provider` from `agent.yaml` or runtime settings.
   - Ensure the cost-tracking and persistence utilities (`utils/cost.js`, storage helpers) receive the new provider’s usage metrics.

4. **Testing**
   - Add unit tests under `tests/` that exercise the adapter with mocked HTTP responses and verify error handling.
   - When feasible, include integration tests or scripts that can run against mock servers to validate headers, payloads, and prompt templates.

## Coding Standards

- Write small, focused functions with intention-revealing names.
- Prefer pure modules with explicit inputs/outputs; avoid hidden side-effects.
- Validate assumptions early and fail fast with descriptive errors.
- Keep dependencies minimal and encapsulate third-party APIs behind adapters.
- Maintain consistent formatting (Prettier/ESLint defaults) and follow Clean Code principles.
- Update documentation alongside code changes and keep prompts/configuration in sync with implementation.

## Submitting Changes

1. Fork the repository and create a topic branch.
2. Run `npm install` and execute the relevant test suites (e.g., `npm test`).
3. Open a pull request describing the change, its motivation, and any testing performed.
4. Be responsive to feedback and keep the discussion focused on the code.

We appreciate your contributions and look forward to collaborating!
