import { FastifyRequest, FastifyReply } from "fastify";
import {
  TelegramUpdate,
  sendChatAction,
  sendMessage,
  getTelegramFileUrl,
} from "../services/telegram.service";
import { logger } from "../utils/logger";
import { processOnboarding } from "../services/onboarding.service";
import { getUser } from "../services/user.service";
import { processFarmerMessage } from "../services/messageProcessor.service";
import { logInteraction } from "../services/interaction.service";

/**
 * Validates and routes Telegram webhooks intelligently
 */
const routeFarmerWebhook = async (update: TelegramUpdate) => {
  if (!update.message) return;

  const chatId = update.message.chat.id;
  const messageText = update.message.text;
  const photoFileId = update.message.photo
    ? update.message.photo[update.message.photo.length - 1].file_id
    : undefined;
  const voiceFileId = update.message.voice?.file_id;

  logger.info(
    { chatId, messageText, photoFileId, voiceFileId },
    "Parsed Telegram Update in Controller",
  );

  try {
    // 1. Checks if user is onboarded. If not → run onboarding.
    const isOnboarding = await processOnboarding(chatId, messageText);
    if (isOnboarding) return;

    // Retrieve user for tracking and translation preferences
    const user = await getUser(chatId);

    // Check if voice should be synthesized back (can be added to settings later)
    // By default, turn on audio replies for prototyping
    const wantsAudio = true;

    // 2. If yes: Process message (text/image/voice), Call AI services
    if (messageText) {
      await withChatAction(
        chatId,
        wantsAudio ? "record_voice" : "typing",
        async () => {
          const aiResponse = await processFarmerMessage({
            type: "text",
            content: messageText,
            wantsAudio,
            preferredLanguage: user.language as any,
          });
          await sendMessage(chatId, aiResponse.finalMessageText);
          if (wantsAudio && aiResponse.audioBuffer) {
            const { sendVoice } = await import("../services/telegram.service");
            await sendVoice(chatId, aiResponse.audioBuffer);
          }
          if (user.id)
            await logInteraction({
              user_id: user.id,
              type: "text",
              crop: aiResponse.structuredAdvice.crop,
              issue: aiResponse.structuredAdvice.issue,
            });
        },
      );
    } else if (photoFileId) {
      const url = await getTelegramFileUrl(photoFileId);
      if (url) {
        await withChatAction(
          chatId,
          wantsAudio ? "record_voice" : "typing",
          async () => {
            const aiResponse = await processFarmerMessage({
              type: "image",
              content: url,
              wantsAudio,
              preferredLanguage: user.language as any,
            });
            await sendMessage(chatId, aiResponse.finalMessageText);
            if (wantsAudio && aiResponse.audioBuffer) {
              const { sendVoice } =
                await import("../services/telegram.service");
              await sendVoice(chatId, aiResponse.audioBuffer);
            }
            if (user.id)
              await logInteraction({
                user_id: user.id,
                type: "image",
                crop: aiResponse.structuredAdvice.crop,
                issue: aiResponse.structuredAdvice.issue,
              });
          },
        );
      } else {
        await sendMessage(
          chatId,
          "Sorry, I couldn't download your image. Please try again.",
        );
      }
    } else if (voiceFileId) {
      const url = await getTelegramFileUrl(voiceFileId);
      if (url) {
        await withChatAction(
          chatId,
          wantsAudio ? "record_voice" : "typing",
          async () => {
            const audioBuffer = await downloadTelegramFile(url);
            const aiResponse = await processFarmerMessage({
              type: "voice",
              content: audioBuffer,
              wantsAudio,
              preferredLanguage: user.language as any,
            });
            await sendMessage(chatId, aiResponse.finalMessageText);
            if (wantsAudio && aiResponse.audioBuffer) {
              const { sendVoice } =
                await import("../services/telegram.service");
              await sendVoice(chatId, aiResponse.audioBuffer);
            }
            if (user.id)
              await logInteraction({
                user_id: user.id,
                type: "voice",
                crop: aiResponse.structuredAdvice.crop,
                issue: aiResponse.structuredAdvice.issue,
              });
          },
        );
      } else {
        await sendMessage(
          chatId,
          "Sorry, I couldn't download your voice note.",
        );
      }
    } else {
      await sendMessage(
        chatId,
        "I received your message, but I only understand text, pictures of crops, and voice notes.",
      );
    }
  } catch (err) {
    logger.error(
      err,
      "Critical error executing webhook payload routing pipeline",
    );
    // Graceful error fallback
    await sendMessage(
      chatId,
      "Sorry, I encountered an internal error processing your request. Please try again shortly.",
    );
  }
};

const downloadTelegramFile = async (url: string): Promise<Buffer> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download Telegram file: ${response.status} ${response.statusText}`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
};

const withChatAction = async (
  chatId: number,
  action: "typing" | "record_voice",
  handler: () => Promise<void>,
): Promise<void> => {
  let interval: NodeJS.Timeout | null = null;

  try {
    await sendChatAction(chatId, action);
    interval = setInterval(() => {
      void sendChatAction(chatId, action);
    }, 4000);

    await handler();
  } finally {
    if (interval) {
      clearInterval(interval);
    }
  }
};

export const handleTelegramWebhook = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  try {
    const update = request.body as TelegramUpdate;

    // Telegram expects a 200 OK immediately.
    // Process asynchronously so we don't hold the connection.
    routeFarmerWebhook(update).catch((err) => {
      logger.error(
        err,
        "Failed asynchronous execution of Telegram controller routing",
      );
    });

    return reply.status(200).send({ success: true });
  } catch (error) {
    logger.error(error, "Error catching Fastify incoming webhook body");
    return reply.status(500).send({ success: false });
  }
};
