import { buildApp } from './app';
import { registerWebhook } from './services/telegram.service';

const startServer = async () => {
  try {
    const app = await buildApp();
    const port = parseInt(process.env.PORT || '3000', 10);
    const host = process.env.HOST || '0.0.0.0';

    await app.listen({ port, host });
    app.log.info(`Server listening on http://${host}:${port}`);

    // Automatically register the webhook dynamically as per Telegram Bot API
    await registerWebhook();
  } catch (err) {
    console.error('Error starting server:', err);
    process.exit(1);
  }
};

startServer();
