import { FarmingAdviceData } from "../farmingAssistant.service";

export type ConversationLanguage = "english" | "french" | "pidgin";
export type TelegramLanguage = "en" | "fr" | "pidgin";

const DOCTOR_PREFIX = "🧑‍🌾 Agro Doctor";

const normalize = (value: string | null | undefined): string =>
  (value || "").trim();

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

const countMatches = (tokens: string[], patterns: Array<RegExp>): number => {
  let count = 0;
  for (const token of tokens) {
    if (patterns.some((pattern) => pattern.test(token))) {
      count += 1;
    }
  }
  return count;
};

const GREETING_PATTERNS = {
  en: [
    /^hi$/,
    /^hello$/,
    /^hey$/,
    /^yo$/,
    /^good$/,
    /^morning$/,
    /^afternoon$/,
    /^evening$/,
    /^greetings$/,
  ],
  fr: [/^bonjour$/, /^salut$/, /^bonsoir$/, /^coucou$/],
  pidgin: [/^how$/, /^far$/, /^abeg$/, /^howfar$/, /^howfar\?$/, /^wazup$/],
};

const GREETING_FILLERS = new Set([
  "there",
  "sir",
  "madam",
  "boss",
  "bro",
  "sis",
  "please",
]);

const LANGUAGE_HINTS = {
  fr: [
    /^bonjour$/,
    /^salut$/,
    /^bonsoir$/,
    /^merci$/,
    /^svp$/,
    /^s'il$/,
    /^plait$/,
    /^je$/,
    /^moi$/,
    /^votre$/,
    /^ma$/,
    /^mon$/,
    /^probleme$/,
    /^plante$/,
  ],
  pidgin: [
    /^abeg$/,
    /^wetin$/,
    /^dey$/,
    /^na$/,
    /^wahala$/,
    /^sabi$/,
    /^una$/,
    /^howfar$/,
    /^how$/,
    /^far$/,
  ],
};

export const detectTelegramLanguageFromText = (
  text?: string | null,
): TelegramLanguage | undefined => {
  const trimmed = (text || "").trim();
  if (!trimmed) return undefined;
  const tokens = tokenize(trimmed);

  const frScore = countMatches(tokens, LANGUAGE_HINTS.fr);
  const pidginScore = countMatches(tokens, LANGUAGE_HINTS.pidgin);

  if (pidginScore > frScore && pidginScore > 0) return "pidgin";
  if (frScore > pidginScore && frScore > 0) return "fr";

  return undefined;
};

export const isTelegramGreeting = (text?: string | null): boolean => {
  const trimmed = (text || "").trim();
  if (!trimmed) return false;
  const tokens = tokenize(trimmed);
  if (tokens.length > 5) return false;

  const greetingScore =
    countMatches(tokens, GREETING_PATTERNS.en) +
    countMatches(tokens, GREETING_PATTERNS.fr) +
    countMatches(tokens, GREETING_PATTERNS.pidgin);
  if (greetingScore === 0) return false;

  const nonGreetingTokens = tokens.filter((token) => {
    const isGreeting =
      GREETING_FILLERS.has(token) ||
      GREETING_PATTERNS.en.some((pattern) => pattern.test(token)) ||
      GREETING_PATTERNS.fr.some((pattern) => pattern.test(token)) ||
      GREETING_PATTERNS.pidgin.some((pattern) => pattern.test(token));
    return !isGreeting;
  });

  return nonGreetingTokens.length === 0;
};

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

const responseFor = (
  advice: FarmingAdviceData,
  language?: TelegramLanguage,
): string => {
  const crop =
    normalize(advice.crop) || (language === "fr" ? "la plante" : "your crop");
  const issue =
    normalize(advice.issue) ||
    (language === "fr" ? "un problème" : "a problem");
  const solution = normalize(advice.solution);
  const tips = normalize(advice.tips);

  if (language === "fr") {
    const parts = [`Je pense que votre ${crop} a ${issue}.`];
    if (solution) parts.push(solution);
    if (tips) parts.push(tips);
    return parts.join(" ");
  }
  if (language === "pidgin") {
    const parts = [`E be like say your ${crop} get ${issue}.`];
    if (solution) parts.push(solution);
    if (tips) parts.push(tips);
    return parts.join(" ");
  }
  const parts = [`It looks like your ${crop} has ${issue}.`];
  if (solution) parts.push(solution);
  if (tips) parts.push(tips);
  return parts.join(" ");
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

export const buildGreetingMessage = (language?: TelegramLanguage): string => {
  if (language === "fr") {
    return withPrefix(
      "Bonjour! Je suis Agro Doctor. Dites-moi la culture et ce que vous voyez, ou envoyez une photo/voix.",
    );
  }
  if (language === "pidgin") {
    return withPrefix(
      "How far! I be Agro Doctor. Tell me the crop and wetin you see, or send photo/voice.",
    );
  }
  return withPrefix(
    "Hello! I am Agro Doctor. Tell me the crop and what you see, or send a photo/voice note.",
  );
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
