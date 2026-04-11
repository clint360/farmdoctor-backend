import { Language } from "./gemini.service";

export function detectLanguageMenuChoice(text: string): Language | null {
  const t = text.trim().toLowerCase();
  if (/^1\b/.test(t) || /\benglish\b/.test(t) || /\banglais\b/.test(t))
    return "english";
  if (/^2\b/.test(t) || /\bfran[cç]ais\b/.test(t) || /\bfrench\b/.test(t))
    return "french";
  if (/^3\b/.test(t) || /\bpidgin\b/.test(t)) return "pidgin";
  return null;
}

// ─── Auto-detect language from message text (broad patterns) ──────
// Pidgin checked first because it overlaps with English
const PID_PATTERNS = /\b(how\s*far|how\s*body|a\s+di|wetin|oya|abeg|sabi|dey|pikin|wahala|na\s+so|make\s+i|wusai|which\s*kain|no\s+be|e\s+be\s+like|sharp|chop|waka|tok|moni|masa|kontri|wey|dat|dis|am|sef|dem|for\s+where|e\s+don|yi|no\s+wahala|a\s+beg|chai|hia|nah|e\s+get)\b/i;
const FR_PATTERNS = /\b(bonjour|salut|bonsoir|bonne\s*(nuit|journée)|s'il\s+vous\s+pla[iî]t|svp|aidez|merci|comment|mes\s+cultures?|je\s+suis|j'ai|mon|ma|nous|oui|non|bien|mal|problème|maladie|feuille|plante|aide|besoin|ça|est|les|des|une?|avec|pour|dans|sur|qui|que|pas|aussi|peut|faire|voir|dit|comme|très)\b/i;
const EN_PATTERNS = /\b(hi|hello|hey|yo|good\s*(morning|afternoon|evening|day)|how\s+are\s+you|help|please|my\s+crop|thank|thanks|need|want|can\s+you|what|which|where|when|how|who|the|this|that|have|has|is|are|was|were|will|would|could|should|plant|leaf|leaves|disease|problem|issue|farm|grow|soil|water|rain|pest|insect|worm|fruit|seed|root|maize|cocoa|tomato|cassava|banana|pepper|bean|rice|yam|potato|mango|orange|pawpaw|plantain|okra)\b/i;

export function detectLanguageFromText(text: string): Language | null {
  const t = text.trim();
  if (PID_PATTERNS.test(t)) return "pidgin";
  if (FR_PATTERNS.test(t)) return "french";
  if (EN_PATTERNS.test(t)) return "english";
  // Default to English if we have any alphabetic content at all
  if (/[a-zA-Z]{2,}/.test(t)) return "english";
  return null;
}

export function askCity(language: Language): string {
  switch (language) {
    case "french":
      return "Bienvenue sur Farm Doctor ! 🌱 Je suis votre assistant agricole IA.\n\nDans quelle ville cultivez-vous ?";
    case "pidgin":
      return "Welcome to Farm Doctor! 🌱 A be your AI farm helper.\n\nWhich city you dey farm from?";
    default:
      return "Welcome to Farm Doctor! 🌱 I'm your AI farming assistant.\n\nWhich city are you farming from?";
  }
}

export function cityConfirmation(language: Language, city: string): string {
  switch (language) {
    case "french":
      return `Merci ! 🌱 Comment puis-je vous aider avec vos cultures ?`;
    case "pidgin":
      return `Sharp! 🌱 How I fit help you with your farm?`;
    default:
      return `Thanks! � How can I help you with your crops?`;
  }
}

export function languageUnknownFallback(): string {
  return "Please choose a language by replying 1 (English), 2 (Français), or 3 (Pidgin).";
}

export function createSubscriptionLimitMessage(
  language: Language,
  limitType: "messages" | "images" | "voice",
  plan: string,
  limit: number
): string {
  const visitLink = "\n\nVisit: https://farm-doctor.vercel.app/subscribe";
  
  switch (language) {
    case "french":
      if (limitType === "messages") {
        return `Vous avez utilisé vos ${limit} messages gratuits ce mois. Abonnez-vous pour continuer!\n\nLes plans commencent à 1 000 XAF/mois.${visitLink}`;
      } else if (limitType === "images") {
        return `Vous avez atteint votre limite mensuelle d'analyses d'images (${limit}). Mettez à niveau votre plan pour plus!${visitLink}`;
      } else {
        return `Vous avez atteint votre limite mensuelle de voix (${limit} minutes). Mettez à niveau votre plan pour plus!${visitLink}`;
      }
    
    case "pidgin":
      if (limitType === "messages") {
        return `You don use your ${limit} free messages for this month. Subscribe to continue!\n\nPlans start at 1,000 XAF/month.${visitLink}`;
      } else if (limitType === "images") {
        return `You don reach your monthly image limit (${limit}). Upgrade your plan for more!${visitLink}`;
      } else {
        return `You don reach your monthly voice limit (${limit} minutes). Upgrade your plan for more!${visitLink}`;
      }
    
    default: // english
      if (limitType === "messages") {
        return `You've used your ${limit} free messages this month. Subscribe to continue!\n\nPlans start at 1,000 XAF/month.${visitLink}`;
      } else if (limitType === "images") {
        return `You've reached your monthly image analysis limit (${limit}). Upgrade your plan for more!${visitLink}`;
      } else {
        return `You've reached your monthly voice limit (${limit} minutes). Upgrade your plan for more!${visitLink}`;
      }
  }
}
