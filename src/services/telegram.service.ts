import { logger } from "../utils/logger";
import { processOnboarding } from "./onboarding.service";
import { getUser } from "./user.service";
import { processFarmerMessage } from "./messageProcessor.service";
import { logInteraction } from "./interaction.service";

export const getTelegramFileUrl = async (
  fileId: string,
): Promise<string | null> => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const res = await fetch(
    `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`,
  );
  const data = (await res.json()) as any;
  if (!res.ok || !data.ok) return null;
  return `https://api.telegram.org/file/bot${token}/${data.result.file_path}`;
};

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: {
      id: number;
      is_bot: boolean;
      first_name: string;
      language_code?: string;
    };
    chat: {
      id: number;
      type: string;
    };
    date: number;
    text?: string;
    photo?: Array<{
      file_id: string;
      file_unique_id: string;
      width: number;
      height: number;
      file_size?: number;
    }>;
    voice?: {
      file_id: string;
      file_unique_id: string;
      duration: number;
      mime_type?: string;
      file_size?: number;
    };
  };
  callback_query?: {
    id: string;
    from: {
      id: number;
      is_bot: boolean;
      first_name: string;
      language_code?: string;
    };
    message?: {
      message_id: number;
      chat: {
        id: number;
        type: string;
      };
    };
    data?: string;
  };
}

// Orchestration moved to controller

const splitTelegramMessage = (text: string, maxLength = 4000): string[] => {
  if (text.length <= maxLength) {
    return [text];
  }

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
      splitIndex = maxLength;
    }

    parts.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }

  if (remaining.length) {
    parts.push(remaining);
  }

  return parts;
};

export const sendMessage = async (
  chatId: number,
  text: string,
  keyboard?: any,
) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.error("TELEGRAM_BOT_TOKEN is missing in environment variables");
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  const messageParts = splitTelegramMessage(text);

  for (let index = 0; index < messageParts.length; index += 1) {
    const payload: any = {
      chat_id: chatId,
      text: messageParts[index],
    };

    if (keyboard && index === messageParts.length - 1) {
      payload.reply_markup = keyboard;
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.text();
        logger.error(
          { errorData, status: response.status },
          "Failed to send Telegram message",
        );
        return;
      }
    } catch (error) {
      logger.error(error, "Error sending message to Telegram");
      return;
    }
  }

  logger.info(
    { chatId, parts: messageParts.length },
    "Successfully sent Telegram message",
  );
};

export const sendVoice = async (chatId: number, audioBuffer: Buffer) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.error("TELEGRAM_BOT_TOKEN is missing in environment variables");
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendVoice`;

  const formData = new FormData();
  formData.append("chat_id", chatId.toString());

  // Create a Blob from the Buffer for the FormData
  const blob = new Blob([new Uint8Array(audioBuffer)], { type: "audio/ogg" });
  formData.append("voice", blob, "voice.ogg");

  try {
    const response = await fetch(url, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const errorData = await response.text();
      logger.error(
        { errorData, status: response.status },
        "Failed to send voice to Telegram",
      );
    } else {
      logger.info({ chatId }, "Successfully sent voice to Telegram");
    }
  } catch (error) {
    logger.error(error, "Error sending voice to Telegram");
  }
};

export const sendChatAction = async (
  chatId: number,
  action: "typing" | "record_voice",
): Promise<void> => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.error("TELEGRAM_BOT_TOKEN is missing in environment variables");
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendChatAction`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ chat_id: chatId, action }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      logger.warn(
        { errorData, status: response.status },
        "Failed to send chat action to Telegram",
      );
    }
  } catch (error) {
    logger.warn(error, "Error sending chat action to Telegram");
  }
};

export const answerCallbackQuery = async (
  callbackQueryId: string,
  text?: string,
): Promise<void> => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.error("TELEGRAM_BOT_TOKEN is missing in environment variables");
    return;
  }

  const url = `https://api.telegram.org/bot${token}/answerCallbackQuery`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      logger.warn(
        { errorData, status: response.status },
        "Failed to answer callback query",
      );
    }
  } catch (error) {
    logger.warn(error, "Error answering callback query");
  }
};

export const registerWebhook = async () => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;

  if (!token || !webhookUrl || webhookUrl.includes("your-public-url.com")) {
    logger.warn(
      "Skipping Telegram webhook registration. Token or Webhook URL missing/invalid.",
    );
    return;
  }

  const url = `https://api.telegram.org/bot${token}/setWebhook`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: webhookUrl }),
    });

    const data = (await response.json()) as any;
    if (!response.ok || !data.ok) {
      logger.error(
        { data, status: response.status },
        "Failed to register Telegram webhook",
      );
    } else {
      logger.info({ webhookUrl }, "Successfully registered Telegram webhook");
    }
  } catch (error) {
    logger.error(error, "Error registering Telegram webhook");
  }
};

export const registerCommands = async () => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.warn("Skipping Telegram commands registration. Token missing.");
    return;
  }

  const url = `https://api.telegram.org/bot${token}/setMyCommands`;
  const commands = [
    { command: "menu", description: "Show options" },
    { command: "settings", description: "Reset your preferences" },
    { command: "start", description: "Start over" },
  ];

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands }),
    });

    const data = (await response.json()) as any;
    if (!response.ok || !data.ok) {
      logger.error(
        { data, status: response.status },
        "Failed to register Telegram commands",
      );
    } else {
      logger.info("Successfully registered Telegram commands");
    }
  } catch (error) {
    logger.error(error, "Error registering Telegram commands");
  }
};
