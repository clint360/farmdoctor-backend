import { FastifyRequest, FastifyReply } from "fastify";
import {
  TelegramUpdate,
  sendChatAction,
  sendMessage,
  getTelegramFileUrl,
  answerCallbackQuery,
} from "../services/telegram.service";
import { logger } from "../utils/logger";
import { processOnboarding } from "../services/onboarding.service";
import { getUser, updateUser } from "../services/user.service";
import { processFarmerMessage } from "../services/messageProcessor.service";
import { logInteraction } from "../services/interaction.service";
import {
  getOrCreateConversationForPlatform,
  updateConversation,
  updateProfile,
} from "../services/whatsapp/memory.service";
import {
  buildDoctorMessagesFromAdvice,
  buildDoctorMessagesFromText,
  buildGreetingMessage,
  buildInlineActions,
  buildLanguageOptionsKeyboard,
  detectTelegramLanguageFromText,
  delay,
  isTelegramGreeting,
  mapCallbackLanguage,
  mapConversationLanguageToTelegram,
  mapTelegramLanguageToConversation,
} from "../services/telegram/ux.service";

const resolvePreferredLanguage = (
  conversationLanguage?: string | null,
  profileLanguage?: string | null,
  userLanguage?: string | null,
) => {
  const fromConversation =
    mapConversationLanguageToTelegram(conversationLanguage);
  if (fromConversation) return fromConversation;

  const fromProfile = mapConversationLanguageToTelegram(profileLanguage);
  if (fromProfile) return fromProfile;

  if (
    userLanguage === "en" ||
    userLanguage === "fr" ||
    userLanguage === "pidgin"
  ) {
    return userLanguage;
  }

  return undefined;
};

const sendDoctorMessages = async (
  chatId: number,
  messages: string[],
  delayMs: number,
) => {
  for (let index = 0; index < messages.length; index += 1) {
    await sendMessage(chatId, messages[index]);
    if (index < messages.length - 1) {
      await delay(delayMs);
    }
  }
};

/**
 * Validates and routes Telegram webhooks intelligently
 */
const routeTelegramCallback = async (
  update: TelegramUpdate,
): Promise<boolean> => {
  if (!update.callback_query) return false;

  const callback = update.callback_query;
  const chatId = callback.message?.chat.id;
  if (!chatId) return true;

  const data = callback.data || "";
  await answerCallbackQuery(callback.id);

  const phone = `tg_${chatId}`;
  const { conversation, profile } = await getOrCreateConversationForPlatform(
    phone,
    "telegram",
    callback.from?.first_name,
  );

  const user = await getUser(chatId);

  const languageSelection = mapCallbackLanguage(data);
  if (languageSelection) {
    if (!user.has_onboarded) {
      const handled = await processOnboarding(chatId, undefined, data, {
        onLanguageSelected: async (lang) => {
          await updateConversation(conversation.id, {
            language: mapTelegramLanguageToConversation(lang),
          });
          await updateProfile(profile.id, {
            preferred_language: mapTelegramLanguageToConversation(lang),
          });
        },
      });
      return handled;
    }

    await updateConversation(conversation.id, {
      language: languageSelection.conversation,
    });
    await updateProfile(profile.id, {
      preferred_language: languageSelection.conversation,
    });
    if (user.language !== languageSelection.telegram) {
      await updateUserLanguage(chatId, languageSelection.telegram);
    }

    const confirmText =
      languageSelection.telegram === "fr"
        ? "🧑‍🌾 Agro Doctor\n\nD'accord. Je vais repondre en francais."
        : languageSelection.telegram === "pidgin"
          ? "🧑‍🌾 Agro Doctor\n\nNo wahala. I go talk pidgin with you."
          : "🧑‍🌾 Agro Doctor\n\nAlright. I will reply in English.";
    await sendMessage(chatId, confirmText);
    return true;
  }

  if (data === "language") {
    await sendMessage(
      chatId,
      "🧑‍🌾 Agro Doctor\n\nPick your language:",
      buildLanguageOptionsKeyboard(),
    );
    return true;
  }

  if (data === "voice") {
    await updateProfile(profile.id, { prefers_voice: true });
    await sendMessage(
      chatId,
      "🧑‍🌾 Agro Doctor\n\nPlease send a voice note, I am listening.",
    );
    return true;
  }

  if (data === "image") {
    await sendMessage(
      chatId,
      "🧑‍🌾 Agro Doctor\n\nPlease send a clear photo of the crop.",
    );
    return true;
  }

  const onboardingHandled = await processOnboarding(chatId, undefined, data, {
    onLanguageSelected: async (lang) => {
      await updateConversation(conversation.id, {
        language: mapTelegramLanguageToConversation(lang),
      });
      await updateProfile(profile.id, {
        preferred_language: mapTelegramLanguageToConversation(lang),
      });
    },
    onLocationSelected: async (location) => {
      await updateConversation(conversation.id, { city: location });
    },
  });

  return onboardingHandled;
};

const updateUserLanguage = async (
  chatId: number,
  language: "en" | "fr" | "pidgin",
) => {
  await updateUser(chatId, { language });
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

const routeFarmerWebhook = async (update: TelegramUpdate) => {
  if (await routeTelegramCallback(update)) return;
  if (!update.message) return;

  const chatId = update.message.chat.id;

  const phone = `tg_${chatId}`;
  const { conversation, profile } = await getOrCreateConversationForPlatform(
    phone,
    "telegram",
    update.message.from?.first_name,
  );
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
    if (messageText === "/menu") {
      await sendMessage(
        chatId,
        "🧑‍🌾 Agro Doctor\n\nHere are your options:",
        buildInlineActions(),
      );
      return;
    }

    const isOnboarding = await processOnboarding(
      chatId,
      messageText,
      undefined,
      {
        onLanguageSelected: async (lang) => {
          await updateConversation(conversation.id, {
            language: mapTelegramLanguageToConversation(lang),
          });
          await updateProfile(profile.id, {
            preferred_language: mapTelegramLanguageToConversation(lang),
          });
        },
        onLocationSelected: async (location) => {
          await updateConversation(conversation.id, { city: location });
        },
      },
    );
    if (isOnboarding) return;

    const user = await getUser(chatId);
    let preferredLanguage = resolvePreferredLanguage(
      conversation.language,
      profile.preferred_language,
      user.language,
    );

    const detectedLanguage = detectTelegramLanguageFromText(messageText);
    if (!preferredLanguage && detectedLanguage) {
      preferredLanguage = detectedLanguage;
    }

    if (!conversation.language && preferredLanguage) {
      await updateConversation(conversation.id, {
        language: mapTelegramLanguageToConversation(preferredLanguage),
      });
      await updateProfile(profile.id, {
        preferred_language:
          mapTelegramLanguageToConversation(preferredLanguage),
      });
      if (user.language !== preferredLanguage) {
        await updateUserLanguage(chatId, preferredLanguage);
      }
    }

    const wantsAudio = Boolean(profile.prefers_voice || voiceFileId);

    if (messageText) {
      if (isTelegramGreeting(messageText)) {
        await sendMessage(chatId, buildGreetingMessage(preferredLanguage));
        return;
      }
      const aiResponse = await processFarmerMessage({
        type: "text",
        content: messageText,
        wantsAudio,
        ttsGender: "male",
        preferredLanguage: preferredLanguage as any,
        userId: user.id,
      });
      const doctorMessages =
        aiResponse.shouldLogInteraction === false
          ? buildDoctorMessagesFromText(
              aiResponse.finalMessageText,
              preferredLanguage,
            )
          : buildDoctorMessagesFromAdvice(
              aiResponse.structuredAdvice,
              preferredLanguage,
            );
      await sendDoctorMessages(chatId, doctorMessages, 1000);
      if (wantsAudio && aiResponse.audioBuffer) {
        await sendVoiceWithAction(chatId, aiResponse.audioBuffer);
      }
      if (user.id && aiResponse.shouldLogInteraction !== false)
        await logInteraction(
          {
            user_id: user.id,
            type: "text",
            crop: aiResponse.structuredAdvice.crop,
            issue: aiResponse.structuredAdvice.issue,
          },
          {
            userText: aiResponse.userText,
            assistantText: aiResponse.finalMessageText,
          },
        );
      return;
    }

    if (photoFileId) {
      const url = await getTelegramFileUrl(photoFileId);
      if (url) {
        const aiResponse = await processFarmerMessage({
          type: "image",
          content: url,
          wantsAudio,
          ttsGender: "male",
          preferredLanguage: preferredLanguage as any,
          userId: user.id,
        });
        const doctorMessages =
          aiResponse.shouldLogInteraction === false
            ? buildDoctorMessagesFromText(
                aiResponse.finalMessageText,
                preferredLanguage,
              )
            : buildDoctorMessagesFromAdvice(
                aiResponse.structuredAdvice,
                preferredLanguage,
              );
        await sendDoctorMessages(chatId, doctorMessages, 1000);
        if (wantsAudio && aiResponse.audioBuffer) {
          await sendVoiceWithAction(chatId, aiResponse.audioBuffer);
        }
        if (user.id && aiResponse.shouldLogInteraction !== false)
          await logInteraction(
            {
              user_id: user.id,
              type: "image",
              crop: aiResponse.structuredAdvice.crop,
              issue: aiResponse.structuredAdvice.issue,
            },
            {
              userText: aiResponse.userText,
              assistantText: aiResponse.finalMessageText,
            },
          );
        return;
      }

      await sendMessage(
        chatId,
        "🧑‍🌾 Agro Doctor\n\nSorry, I couldn't download your image. Please try again.",
      );
      return;
    }

    if (voiceFileId) {
      if (!profile.prefers_voice) {
        await updateProfile(profile.id, { prefers_voice: true });
      }
      const url = await getTelegramFileUrl(voiceFileId);
      if (url) {
        await withChatAction(chatId, "record_voice", async () => {
          const audioBuffer = await downloadTelegramFile(url);
          const aiResponse = await processFarmerMessage({
            type: "voice",
            content: audioBuffer,
            wantsAudio,
            ttsGender: "male",
            preferredLanguage: preferredLanguage as any,
            userId: user.id,
          });
          if (wantsAudio && aiResponse.audioBuffer) {
            await sendVoiceWithAction(chatId, aiResponse.audioBuffer);
          }
          if (user.id && aiResponse.shouldLogInteraction !== false)
            await logInteraction(
              {
                user_id: user.id,
                type: "voice",
                crop: aiResponse.structuredAdvice.crop,
                issue: aiResponse.structuredAdvice.issue,
              },
              {
                userText: aiResponse.userText,
                assistantText: aiResponse.finalMessageText,
              },
            );
        });
        return;
      }

      await sendMessage(
        chatId,
        "🧑‍🌾 Agro Doctor\n\nSorry, I couldn't download your voice note.",
      );
      return;
    }

    await sendMessage(
      chatId,
      "🧑‍🌾 Agro Doctor\n\nI received your message, but I only understand text, pictures of crops, and voice notes.",
    );
  } catch (err) {
    logger.error(
      err,
      "Critical error executing webhook payload routing pipeline",
    );
    await sendMessage(
      chatId,
      "🧑‍🌾 Agro Doctor\n\nSorry, I encountered an internal error processing your request. Please try again shortly.",
    );
  }
};

const sendVoiceWithAction = async (chatId: number, audioBuffer: Buffer) => {
  const { sendVoice } = await import("../services/telegram.service");
  await sendVoice(chatId, audioBuffer);
};

export const handleTelegramWebhook = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  try {
    const update = request.body as TelegramUpdate;

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
