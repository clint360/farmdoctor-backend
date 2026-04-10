import { FarmingAdviceData } from "../farmingAssistant.service";

export type ConversationLanguage = "english" | "french" | "pidgin";
export type TelegramLanguage = "en" | "fr" | "pidgin";

const DOCTOR_PREFIX = "🧑‍🌾 Agro Doctor";

const firstSentence = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const split = trimmed
    .split(/\.|\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  return split[0] || trimmed;
};

const normalize = (value: string | null | undefined): string =>
  (value || "").trim();

export const mapConversationLanguageToTelegram = (
  value?: string | null,
): TelegramLanguage | undefined => {
  if (!value) return undefined;
  if (value === "english") return "en";
  if (value === "french") return "fr";
  if (value === "pidgin") return "pidgin";
  return undefined;
};

export const mapTelegramLanguageToConversation = (
  value: TelegramLanguage,
): ConversationLanguage => {
  if (value === "fr") return "french";
  if (value === "pidgin") return "pidgin";
  return "english";
};

export const mapCallbackLanguage = (
  callbackData: string,
): {
  conversation: ConversationLanguage;
  telegram: TelegramLanguage;
} | null => {
  switch (callbackData) {
    case "lang_en":
      return { conversation: "english", telegram: "en" };
    case "lang_fr":
      return { conversation: "french", telegram: "fr" };
    case "lang_pidgin":
      return { conversation: "pidgin", telegram: "pidgin" };
    default:
      return null;
  }
};

const withPrefix = (text: string): string =>
  `${DOCTOR_PREFIX}\n\n${text}`.trim();

const ackFor = (language?: TelegramLanguage): string => {
  if (language === "fr") return "Hmm... je vois. Merci pour le detail.";
  if (language === "pidgin") return "Hmm... I see am. Thanks for talk.";
  return "Hmm... I hear you. Thanks for the details.";
};

const explainFor = (
  advice: FarmingAdviceData,
  language?: TelegramLanguage,
): string => {
  const crop =
    normalize(advice.crop) || (language === "fr" ? "la plante" : "the crop");
  const issue =
    normalize(advice.issue) ||
    (language === "fr" ? "un probleme" : "a problem");

  if (language === "fr") {
    return `Je pense que ${crop} a ${issue}.`;
  }
  if (language === "pidgin") {
    return `E be like say ${crop} get ${issue}.`;
  }
  return `It looks like ${crop} has ${issue}.`;
};

const responseFor = (
  advice: FarmingAdviceData,
  language?: TelegramLanguage,
): string => {
  const crop =
    normalize(advice.crop) || (language === "fr" ? "la plante" : "your crop");
  const solution = firstSentence(normalize(advice.solution)) || "";
  const tips = firstSentence(normalize(advice.tips)) || "";

  if (language === "fr") {
    return `D'accord. Pour ${crop}, je vous conseille ${solution || "d'enlever les parties atteintes"}, puis ${tips || "de garder la plante propre"}.`;
  }
  if (language === "pidgin") {
    return `Okay. For ${crop}, I suggest ${solution || "cut the bad part"}, then ${tips || "keep the crop clean"}.`;
  }
  return `Okay. For ${crop}, I suggest ${solution || "remove the bad parts"}, then ${tips || "keep the crop clean"}.`;
};

export const buildDoctorMessagesFromAdvice = (
  advice: FarmingAdviceData,
  language?: TelegramLanguage,
): string[] => {
  const response = responseFor(advice, language);
  return [withPrefix(response)];
};

export const buildDoctorMessagesFromText = (
  text: string,
  language?: TelegramLanguage,
): string[] => {
  const trimmed = text.trim();
  if (!trimmed) {
    return [withPrefix(ackFor(language))];
  }

  const message =
    language === "fr"
      ? `D'accord. ${trimmed}`
      : language === "pidgin"
        ? `Okay. ${trimmed}`
        : `Okay. ${trimmed}`;

  return [withPrefix(message)];
};

export const buildInlineActions = (): { inline_keyboard: Array<any> } => {
  const webAppUrl = process.env.TELEGRAM_WEB_APP_URL;
  const keyboard: Array<any> = [
    [{ text: "🎤 Talk to Doctor", callback_data: "voice" }],
    [{ text: "📷 Send Crop Image", callback_data: "image" }],
    [{ text: "🌍 Change Language", callback_data: "language" }],
  ];

  if (webAppUrl) {
    keyboard.push([
      { text: "🚀 Open Voice Assistant", web_app: { url: webAppUrl } },
    ]);
  }

  return { inline_keyboard: keyboard };
};

export const buildLanguageOptionsKeyboard = (): {
  inline_keyboard: Array<any>;
} => {
  return {
    inline_keyboard: [
      [
        { text: "🇬🇧 English", callback_data: "lang_en" },
        { text: "🇫🇷 French", callback_data: "lang_fr" },
      ],
      [{ text: "🇨🇲 Pidgin", callback_data: "lang_pidgin" }],
    ],
  };
};

export const buildLocationSkipKeyboard = (): {
  inline_keyboard: Array<any>;
} => ({
  inline_keyboard: [[{ text: "Skip", callback_data: "skip_location" }]],
});

export const delay = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
