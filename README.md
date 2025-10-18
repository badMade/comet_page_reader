#README.md
You are an experienced JavaScript developer tasked with building a cost‑efficient, cross‑browser screen‑reader extension (WebExtensions API) that works in Chrome, Firefox, Edge and Comet. The goal is to read web pages aloud, answer spoken questions about the current page and minimize API costs.

Key requirements:

Architecture

Use a background service worker to store a user‑provided OpenAI API key securely and make all API requests.

Inject content scripts to extract visible text from the page, filter out hidden elements and send the content to the background script.

Create a popup UI (HTML/CSS/JS) with fields for the API key, TTS voice selection, controls to start/stop reading, a push‑to‑talk button to record voice commands, language selection and cost/usage settings.

Ensure the extension runs in Chromium‑based browsers and Firefox via WebExtensions.

Speech‑to‑Text (STT)

Use the MediaRecorder API to capture microphone input when the user holds down the push‑to‑talk button.

Encode the recording in an accepted format (e.g., audio/webm or audio/wav) and send it as FormData to the OpenAI /v1/audio/transcriptions endpoint using the whisper‑1 model (which costs about $0.006/minute).

Accept only recordings ≤25 MB and split longer recordings into chunks if needed.

Parse the JSON or plain‑text response to recognize commands (e.g., “read page”, “scroll down”, “summarize page”) or questions.

For questions, forward the transcribed text to the chat completion endpoint.

Chat Completion

Use the /v1/chat/completions endpoint with the gpt‑3.5‑turbo model by default (cheaper) and gpt‑4o only when necessary.

For summarizing page content, pass a system prompt such as “Summarize this page for a visually‑impaired user; preserve headings and important links” and keep messages concise.

Minimize token usage by summarizing long pages before synthesis and by providing precise prompts.

Text‑to‑Speech (TTS)

Call the /v1/audio/speech endpoint with the gpt‑4o‑mini‑tts model and a user‑selected voice (e.g., alloy, ash, ballad, coral, echo, fable, nova, onyx, sage or shimmer).

Request streaming responses so the audio begins playing immediately.

Use MP3 by default; allow users to select WAV/PCM for lower latency if desired.

Use <audio> elements or the Web Audio API to play the returned audio; implement pause, resume and skip controls.

Caching and Cost Controls

Cache summaries and generated audio by URL/section to avoid repeated API calls.

Expose settings to set monthly cost limits and display estimated usage (e.g., minutes of audio transcribed and generated).

Provide a toggle to disable transcription on long pages and a disclaimer that the generated voice is AI‑produced.

Accessibility & Localization

Ensure all UI elements are keyboard‑accessible and labeled with ARIA attributes.

Support multiple languages for STT and TTS; allow users to select input and output languages.

Display the transcript of recognized speech for user review.

Testing & Deployment

Include a manifest.json configured for WebExtensions v3.

Provide example background script (background.js or service_worker.js), content script (content.js), popup HTML/CSS/JS, and any utility modules.

Test the extension across different websites and browsers.

Adhere to privacy and store policies when publishing.

Write the code for this extension, including manifest, scripts and HTML/CSS files, with clear comments explaining each part.