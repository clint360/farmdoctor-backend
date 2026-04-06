# Farm Doctor Backend

Fastify + TypeScript backend for the Farm Doctor assistant. It supports Telegram messaging, image analysis with Gemini/Vertex, and Google Cloud TTS/STT for voice interactions.

## Features

- Text, image, and voice message processing
- Gemini API with Vertex AI fallback for analysis and translation
- Google Cloud Speech-to-Text for voice notes
- Google Cloud Text-to-Speech with OGG/Opus output for Telegram
- Platform-agnostic message pipeline (adapters per platform)

## Project Structure

- src/controllers
  - HTTP/webhook handlers (Telegram)
- src/routes
  - Fastify route definitions
- src/services
  - AI, messaging, and integration services
- src/utils
  - Logging utilities

## Requirements

- Node.js 20+
- ffmpeg available on PATH
- Google Cloud service account JSON for TTS/STT (and Vertex if enabled)

## Setup

1) Install dependencies:

```
npm install
```

2) Create a .env file (see example below) and fill in your keys.

3) Run in development:

```
npm run dev
```

4) Build and run:

```
npm run build
npm start
```

## Environment Variables

Create a .env file in the project root and set these values:

```
# Application config
PORT=3000
HOST=0.0.0.0
LOG_LEVEL=info

# Telegram
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_URL=

# Supabase
SUPABASE_URL=
SUPABASE_KEY=

# Gemini API (primary)
GEMINI_API_KEY=

# Google Cloud auth
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json

# Vertex AI (Gemini fallback)
VERTEX_PROJECT_ID=
VERTEX_LOCATION=us-central1
VERTEX_GEMINI_MODEL=

# TTS voice tuning (optional)
TTS_LANG_EN=en-GB
TTS_LANG_PIDGIN=en-NG
TTS_LANG_FR=fr-FR
TTS_VOICE_EN=
TTS_VOICE_PIDGIN=
TTS_VOICE_FR=
```

Notes:
- If VERTEX_PROJECT_ID is empty, the app will not attempt Vertex fallback.
- The service account must have Vertex AI User role to use Vertex fallback.

## Telegram Webhook

Set your webhook to:

```
https://<your-public-url>/webhook/telegram
```

The backend will respond immediately (200 OK) and process messages asynchronously.

## TTS and STT

- STT: Telegram voice notes are converted to LINEAR16 (16 kHz) before transcription.
- TTS: Text is synthesized as LINEAR16 (24 kHz) and converted to OGG/Opus for Telegram.

## Image Analysis

Images are resized and compressed before analysis to reduce latency and request size.

## Scripts

- npm run dev: Start with tsx watch
- npm run build: Compile TypeScript
- npm start: Run compiled output

## Troubleshooting

- Gemini quota errors (429): Enable billing or configure Vertex fallback.
- Vertex 403: Ensure the service account has Vertex AI User role.
- Vertex 404: The model name or region may be invalid. Use Model Garden to confirm.
- TTS/STT failures: Ensure GOOGLE_APPLICATION_CREDENTIALS is correct and ffmpeg is installed.

## License

ISC
