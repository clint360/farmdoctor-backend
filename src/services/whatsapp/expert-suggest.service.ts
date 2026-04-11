import { getExpertsByCity } from "../expert.service";
import { getSubscription, PLAN_LIMITS, PlanLimits } from "../subscription.service";
import { sendWhatsAppButtons } from "../whatsapp.service";
import { sendTextAndLog } from "./send.service";
import { logMessage } from "./messages.service";
import { Language } from "./gemini.service";
import { logger } from "../../utils/logger";

// ─── Cooldown: one expert suggestion per conversation per 24 h ───
const lastSuggested = new Map<string, number>();
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

function cleanCooldowns(): void {
  const now = Date.now();
  for (const [id, ts] of lastSuggested) {
    if (now - ts > COOLDOWN_MS) lastSuggested.delete(id);
  }
}

// ─── Multilingual copy ──────────────
function expertOfferText(lang: Language, city: string): string {
  switch (lang) {
    case "french":
      return `🌾 Besoin d'aide professionnelle ?\nNous pouvons vous connecter avec des experts agricoles près de ${city}.`;
    case "pidgin":
      return `🌾 You need expert help?\nWe fit connect you with farm experts for ${city}.`;
    default:
      return `🌾 Need professional help?\nWe can connect you with agricultural experts near ${city}.`;
  }
}

function expertListText(
  lang: Language,
  city: string,
  experts: Array<{ full_name: string; phone: string }>,
): string {
  const header =
    lang === "french"
      ? `🌾 *Experts Agricoles près de ${city} :*`
      : lang === "pidgin"
        ? `🌾 *Farm Experts for ${city}:*`
        : `🌾 *Agricultural Experts near ${city}:*`;

  const list = experts
    .slice(0, 5) // cap at 5
    .map((e, i) => `${i + 1}. *${e.full_name}*\n   📞 ${e.phone}`)
    .join("\n\n");

  const footer =
    lang === "french"
      ? "Contactez-les directement pour une aide professionnelle !"
      : lang === "pidgin"
        ? "Call dem direct for professional help!"
        : "Contact them directly for professional help with your crops!";

  return `${header}\n\n${list}\n\n${footer}`;
}

function noExpertsText(lang: Language, city: string): string {
  switch (lang) {
    case "french":
      return `Désolé, aucun expert n'est disponible près de votre champ pour le moment. Nous travaillons à en ajouter !`;
    case "pidgin":
      return `Sorry, no expert dey for your corner farm now. We dey work to add some!`;
    default:
      return `Sorry, no experts are available near your farm at the moment. We're working on adding more!`;
  }
}

function buttonLabels(lang: Language): { yes: string; no: string } {
  switch (lang) {
    case "french":
      return { yes: "Oui, merci", no: "Non merci" };
    case "pidgin":
      return { yes: "Yes abeg", no: "No, I dey ok" };
    default:
      return { yes: "Yes please", no: "No thanks" };
  }
}

// ─── Main: maybe offer expert help ──
export async function maybeSuggestExpert(
  phone: string,
  conversationId: string,
  city: string | null,
  language: Language,
): Promise<void> {
  try {
    if (!city) return;

    // Cooldown check
    if (lastSuggested.size > 500) cleanCooldowns();
    const lastTime = lastSuggested.get(conversationId);
    if (lastTime && Date.now() - lastTime < COOLDOWN_MS) return;

    // Subscription check — only Pro & Cooperative can access experts
    const sub = await getSubscription(phone);
    const plan =
      sub && sub.status === "active" && new Date(sub.expires_at) > new Date()
        ? sub.plan
        : "free";
    const limits: PlanLimits | undefined = PLAN_LIMITS[plan];
    if (!limits?.can_access_experts) return;

    // Check if experts exist near the farmer's city
    const experts = await getExpertsByCity(city);
    if (experts.length === 0) return;

    // Mark cooldown BEFORE sending (prevents race condition on double-send)
    lastSuggested.set(conversationId, Date.now());

    // Send interactive buttons
    const labels = buttonLabels(language);
    await sendWhatsAppButtons(phone, expertOfferText(language, city), [
      { id: "expert_yes", title: labels.yes },
      { id: "expert_no", title: labels.no },
    ]);

    await logMessage({
      conversation_id: conversationId,
      direction: "out",
      type: "text",
      body: expertOfferText(language, city),
    });
  } catch (err) {
    // Non-critical — never break the main flow
    logger.error(err, "maybeSuggestExpert failed");
  }
}

// ─── Handle user's yes/no reply ─────
export async function handleExpertResponse(
  phone: string,
  conversationId: string,
  city: string | null,
  language: Language,
  accepted: boolean,
): Promise<void> {
  if (!accepted) {
    const ack =
      language === "french"
        ? "D'accord ! N'hésitez pas à demander plus tard."
        : language === "pidgin"
          ? "Ok! You fit ask later if you want."
          : "Alright! Feel free to ask later if you need help.";
    await sendTextAndLog(phone, ack, conversationId);
    return;
  }

  if (!city) return;

  const experts = await getExpertsByCity(city);
  if (experts.length === 0) {
    await sendTextAndLog(phone, noExpertsText(language, city), conversationId);
    return;
  }

  await sendTextAndLog(
    phone,
    expertListText(language, city, experts),
    conversationId,
  );
}
