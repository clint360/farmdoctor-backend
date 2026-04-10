import { getUser, updateUser } from "./user.service";
import { sendMessage } from "./telegram.service";
import {
  buildInlineActions,
  buildLanguageOptionsKeyboard,
  buildLocationSkipKeyboard,
  mapCallbackLanguage,
} from "./telegram/ux.service";

/**
 * Handles the state machine for first-time user onboarding.
 * Returns true if the message was consumed by onboarding, false otherwise.
 */
type OnboardingSyncHandlers = {
  onLanguageSelected?: (language: "en" | "fr" | "pidgin") => Promise<void>;
  onLocationSelected?: (location: string) => Promise<void>;
  onCompleted?: () => Promise<void>;
};

export const processOnboarding = async (
  chatId: number,
  text?: string,
  callbackData?: string,
  handlers?: OnboardingSyncHandlers,
): Promise<boolean> => {
  const user = await getUser(chatId);

  // Allow resetting preferences at any time
  if (text === "/settings" || text === "/start") {
    await updateUser(chatId, { onboarding_step: 1, has_onboarded: false });
    await sendMessage(
      chatId,
      "🧑‍🌾 Agro Doctor\n\nWelcome to Farm Doctor! Your AI agrarian advisor.",
      buildLanguageOptionsKeyboard(),
    );
    return true;
  }

  if (user.has_onboarded) {
    return false;
  }

  const msgText = text?.trim() || "";

  // Users can skip optional steps
  if (msgText.toLowerCase() === "skip" || callbackData === "skip_location") {
    if (user.onboarding_step === 1) {
      await updateUser(chatId, { language: "en", onboarding_step: 2 });
      if (handlers?.onLanguageSelected) {
        await handlers.onLanguageSelected("en");
      }
      await sendLocationPrompt(chatId);
    } else if (user.onboarding_step === 2) {
      await updateUser(chatId, { has_onboarded: true, onboarding_step: 3 });
      if (handlers?.onCompleted) {
        await handlers.onCompleted();
      }
      await sendMessage(
        chatId,
        "🧑‍🌾 Agro Doctor\n\nSetup complete! Ask me any farming questions or send me pictures of sick crops.\n\nType /menu to see options.",
      );
    }
    return true;
  }

  if (callbackData) {
    const langFromCallback = mapCallbackLanguage(callbackData);
    if (langFromCallback) {
      await updateUser(chatId, {
        language: langFromCallback.telegram,
        onboarding_step: 2,
      });
      if (handlers?.onLanguageSelected) {
        await handlers.onLanguageSelected(langFromCallback.telegram);
      }
      await sendLocationPrompt(chatId);
      return true;
    }
  }

  switch (user.onboarding_step) {
    case 0:
    case 1:
      // Handle Language Selection
      const lang = parseLanguage(msgText);
      if (lang) {
        await updateUser(chatId, { language: lang, onboarding_step: 2 });
        if (handlers?.onLanguageSelected) {
          await handlers.onLanguageSelected(lang);
        }
        await sendLocationPrompt(chatId);
      } else {
        await sendLanguagePrompt(chatId);
      }
      return true;

    case 2:
      // Handle Location Selection
      await updateUser(chatId, {
        location: msgText,
        has_onboarded: true,
        onboarding_step: 3,
      });
      if (handlers?.onLocationSelected) {
        await handlers.onLocationSelected(msgText);
      }
      if (handlers?.onCompleted) {
        await handlers.onCompleted();
      }
      await sendMessage(
        chatId,
        "🧑‍🌾 Agro Doctor\n\nSetup complete! Ask me any farming questions or send me pictures of sick crops.\n\nType /menu to see options.",
      );
      return true;

    default:
      return false;
  }
};

const sendLanguagePrompt = async (chatId: number) => {
  await sendMessage(
    chatId,
    "🧑‍🌾 Agro Doctor\n\nPlease select your preferred language:",
    buildLanguageOptionsKeyboard(),
  );
};

const sendLocationPrompt = async (chatId: number) => {
  await sendMessage(
    chatId,
    "🧑‍🌾 Agro Doctor\n\nGreat! Where is your farm located? (Send text, or tap Skip)",
    buildLocationSkipKeyboard(),
  );
};

const parseLanguage = (text: string): "en" | "fr" | "pidgin" | null => {
  const t = text.toLowerCase();
  if (t.includes("en") || t.includes("english")) return "en";
  if (t.includes("fr") || t.includes("français") || t.includes("french"))
    return "fr";
  if (t.includes("pidgin")) return "pidgin";
  return null;
};
