import { Language } from "./gemini.service";

export function detectLanguageMenuChoice(text: string): Language | null {
  const t = text.trim().toLowerCase();
  if (/^1\b/.test(t) || /\benglish\b/.test(t) || /\banglais\b/.test(t)) return "english";
  if (/^2\b/.test(t) || /\bfran[cç]ais\b/.test(t) || /\bfrench\b/.test(t)) return "french";
  if (/^3\b/.test(t) || /\bpidgin\b/.test(t)) return "pidgin";
  return null;
}

export function welcomeMessage(): string {
  return [
    "Welcome to Farm Doctor 🌱",
    "",
    "Choose your language:",
    "",
    "1️⃣ English",
    "2️⃣ Français",
    "3️⃣ Pidgin",
  ].join("\n");
}

export function askCity(language: Language): string {
  switch (language) {
    case "french":
      return "Parfait, je vais vous répondre en français 🌱\n\nDans quelle ville cultivez-vous ?";
    case "pidgin":
      return "Sharp! A go di tok pidgin with you 🌱\n\nWhich city you dey farm from?";
    default:
      return "Great, I'll reply in English 🌱\n\nWhich city are you farming from?";
  }
}

export function cityConfirmation(language: Language, city: string): string {
  switch (language) {
    case "french":
      return `Merci ! Vous cultivez à ${city}. Posez-moi votre première question sur vos cultures.`;
    case "pidgin":
      return `Tank you! You dey farm for ${city}. Ask me anytin about ya crops.`;
    default:
      return `Thanks! You're farming from ${city}. Ask me anything about your crops.`;
  }
}

export function languageUnknownFallback(): string {
  return "Please choose a language by replying 1 (English), 2 (Français), or 3 (Pidgin).";
}
