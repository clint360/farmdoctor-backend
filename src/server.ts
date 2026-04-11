import fs from "fs";
import os from "os";
import path from "path";
import { buildApp } from "./app";
import { registerWebhook, registerCommands } from "./services/telegram.service";

// If GOOGLE_APPLICATION_CREDENTIALS contains JSON content (not a file path),
// write it to a temp file so the Google SDK can read it correctly.
const googleCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "";
if (googleCreds.trimStart().startsWith("{")) {
  try {
    const tmpPath = path.join(os.tmpdir(), "google-credentials.json");
    fs.writeFileSync(tmpPath, googleCreds, "utf8");
    process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpPath;
    console.log("[startup] Google credentials written to temp file:", tmpPath);
  } catch (err) {
    console.error("[startup] Failed to write Google credentials:", err);
  }
}

const startServer = async () => {
  try {
    const app = await buildApp();
    const port = parseInt(process.env.PORT || "3000", 10);
    const host = process.env.HOST || "0.0.0.0";

    await app.listen({ port, host });
    app.log.info(`Server listening on http://${host}:${port}`);

    // Automatically register the Telegram webhook
    await registerWebhook();
    await registerCommands();

    app.log.info("Available routes:");
    app.log.info("  GET  /api/health");
    app.log.info("  POST /webhook/telegram");
    app.log.info("  GET  /webhook/whatsapp (verification)");
    app.log.info("  POST /webhook/whatsapp");
    app.log.info("  POST /api/expert-apply");
    app.log.info("  GET  /api/expert-apply/status/:transId");
    app.log.info("  GET  /api/experts?city=...");
    app.log.info("  GET  /api/subscription?phone=...");
    app.log.info("  POST /api/subscription");
    app.log.info("  GET  /api/subscription/status/:transId");
    app.log.info("  POST /api/retell/create-web-call");
  } catch (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
};

startServer();
