# 🌾 Farm Doctor Backend

> **AI-powered agricultural assistant helping farmers across Cameroon** — available on WhatsApp and Telegram, speaking English, French, and Cameroon Pidgin.


## ✨ Features

- 💬 **Text, image & voice** message processing on both WhatsApp and Telegram
- 🧠 **AI crop diagnosis** and farming advice powered by Google Gemini (with Vertex AI fallback)
- 🌍 **Automatic language detection** — English, French, and Cameroon Pidgin (Kamtok)
- 🎙️ **Voice-in, voice-out** pipeline:
  - Transcription via Gemini multimodal (audio → text + language detection)
  - 🇨🇲 Pidgin TTS via YarnGPT with Cameroonian voices
  - 🔊 English/French TTS via OpenAI (falls back to Google Cloud TTS)
- 🖼️ Crop image diagnosis with Gemini vision
- 🔍 Agricultural insights search
- 👨‍🌾 Expert directory with Fapshi payment integration
- 💳 Farmer subscriptions with payment processing
- 📞 Retell AI web call support
- 🧠 Conversation memory and history summarisation (Supabase)
- 🚀 Railway deployment with Docker + GitHub Actions CI/CD

---

## 🗂️ Project Structure

```
src/
  controllers/        HTTP and webhook handlers
  services/
    whatsapp/         WhatsApp-specific services (Gemini, voice, memory, handlers)
    ai/               Shared TTS and STT services
    telegram/         Telegram UX utilities
  routes/             Fastify route definitions
  utils/              Logger
  server.ts           Entry point
  app.ts              Fastify app setup
```

---

## 🛣️ API Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | 🏥 Health check |
| `POST` | `/webhook/telegram` | 🤖 Telegram bot webhook |
| `GET` | `/webhook/whatsapp` | ✅ WhatsApp webhook verification |
| `POST` | `/webhook/whatsapp` | 💬 WhatsApp message handler |
| `POST` | `/api/expert-apply` | 👨‍🔬 Expert registration with payment |
| `GET` | `/api/expert-apply/status/:transId` | 💳 Expert payment status |
| `GET` | `/api/experts` | 🔍 List experts by city |
| `GET` | `/api/subscription` | 📋 Get farmer subscription |
| `POST` | `/api/subscription` | 🆕 Create subscription with payment |
| `GET` | `/api/subscription/status/:transId` | 💳 Subscription payment status |
| `POST` | `/api/retell/create-web-call` | 📞 Create Retell AI web call |
| `POST` | `/api/retell/call-ended` | 📴 Retell call ended callback |
| `POST` | `/api/missed-call` | 📵 Handle missed call webhook |
| `GET` | `/api/insights/search` | 🌱 Search agricultural insights |
| `GET` | `/api/insights/suggestions` | 💡 Insight search suggestions |

---

## ✅ Requirements

- 🟢 Node.js 20+
- 🎬 `ffmpeg` on PATH (audio conversion)
- ☁️ Google Cloud service account (for TTS/STT and optional Vertex AI)
- 🔑 Gemini API key or Vertex AI project
- 🗄️ Supabase project (database)

---

## 🛠️ Setup

**1. Install dependencies:**

```bash
npm install
```

**2.** Create a `.env` file (see [Environment Variables](#-environment-variables) below).

**3. Run in development:**

```bash
npm run dev
```

**4. Build and run in production:**

```bash
npm run build
npm start
```

---

## 🔐 Environment Variables

```env
# ── Application ────────────────────────────
PORT=3000
HOST=0.0.0.0
LOG_LEVEL=info
DEFAULT_COUNTRY=Cameroon

# ── Telegram ───────────────────────────────
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_URL=https://your-domain.com/webhook/telegram

# ── WhatsApp (Meta Cloud API) ──────────────
WHATSAPP_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_VERIFY_TOKEN=

# ── Supabase ───────────────────────────────
SUPABASE_URL=
SUPABASE_KEY=

# ── Gemini API (primary AI) ────────────────
GEMINI_API_KEY=
GEMINI_TEXT_MODEL=gemini-2.5-flash
GEMINI_VISION_MODEL=gemini-2.5-flash

# ── Vertex AI (optional Gemini fallback) ───
VERTEX_PROJECT_ID=
VERTEX_LOCATION=us-central1

# ── Google Cloud (TTS/STT fallback) ────────
# Production (Railway): paste the full JSON content of your service account key
# Local: set to the absolute file path of your service account JSON
GOOGLE_APPLICATION_CREDENTIALS=

# ── Google Cloud TTS voice tuning (optional)
TTS_LANG_EN=en-GB
TTS_LANG_FR=fr-FR
TTS_LANG_PIDGIN=en-NG
TTS_VOICE_EN=
TTS_VOICE_FR=
TTS_VOICE_PIDGIN=

# ── OpenAI (English/French TTS) ────────────
OPENAI_API_KEY=
OPENAI_TTS_MODEL=tts-1
OPENAI_TTS_VOICE=alloy
OPENAI_TTS_VOICE_MALE=
OPENAI_TTS_VOICE_FEMALE=

# ── YarnGPT (Pidgin TTS — Cameroonian) ─────
YARNGPT_API_KEY=
YARNGPT_API_URL=https://yarngpt.ai/api/v1/tts
YARNGPT_VOICE=Florentine

# ── Voice replies toggle ────────────────────
ENABLE_VOICE_REPLIES=true

# ── Retell AI (web calls) ───────────────────
RETELL_API_KEY=
RETELL_AGENT_ID=

# ── Fapshi (payments) ──────────────────────
FAPSHI_API_KEY=
FAPSHI_API_USER=
FAPSHI_BASE_URL=
```

---

## ☁️ Google Cloud Credentials

The `GOOGLE_APPLICATION_CREDENTIALS` variable is handled automatically:

| Environment | What to set |
|-------------|-------------|
| 💻 **Local** | Absolute file path to your service account JSON |
| 🚀 **Railway / Production** | Paste the full JSON content directly as the variable value |

The app detects at startup whether the value is a JSON string (starts with `{`), writes it to a temp file, and updates the pointer automatically — no manual file management needed.

---

## 🎤 Voice Pipeline

### 🇨🇲 Pidgin
1. Gemini transcribes the audio and detects language as `pidgin`
2. Gemini generates a reply in English
3. Gemini translates the reply into authentic Cameroon Pidgin (Kamtok)
4. YarnGPT synthesises audio using a Cameroonian voice (`YARNGPT_VOICE=Florentine`)
5. Long responses are chunked (max 300 chars) and concatenated seamlessly

### 🇬🇧 English / 🇫🇷 French
1. Gemini transcribes the audio and detects language
2. Gemini generates a reply
3. OpenAI TTS synthesises audio in Opus format directly (no ffmpeg needed)
4. Falls back to Google Cloud TTS if OpenAI is unavailable

---

## 🚀 Deployment (Railway)

The project ships with a `Dockerfile` based on `node:20-slim` with `ffmpeg` and `libvips` pre-installed.

GitHub Actions automatically deploys to Railway on every merge to `main`:

```
.github/workflows/deploy.yml
```

> Set the `RAILWAY_TOKEN` secret in your GitHub repository **Settings → Secrets → Actions**.

---

## 📜 Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | 🔄 Start with tsx watch (hot reload) |
| `npm run build` | 🏗️ Compile TypeScript |
| `npm start` | ▶️ Run compiled output |

---

## 🧯 Troubleshooting

| Problem | Solution |
|---------|----------|
| 🔴 **Gemini quota (429)** | Enable billing or set `VERTEX_PROJECT_ID` for Vertex AI fallback |
| 🔒 **Vertex 403** | Service account needs the `Vertex AI User` IAM role |
| 🗝️ **Google credentials failing in production** | Paste full JSON as `GOOGLE_APPLICATION_CREDENTIALS` — app writes it to a temp file automatically |
| 🔇 **OpenAI TTS falling back to Google** | Ensure `OPENAI_API_KEY` is set in Railway — client is lazy-initialised and will pick it up |
| 🗣️ **YarnGPT sounds Nigerian** | Set `YARNGPT_VOICE=Florentine` in Railway variables for a Cameroonian voice |
| 🎬 **ffmpeg errors** | `ffmpeg` is included in the Docker image — ensure you're deploying via Docker |

---

## 📄 License

ISC
#   f a r m d o c t o r - b a c k e n d 
 
 
