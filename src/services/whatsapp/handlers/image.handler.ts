import { ParsedWhatsAppMessage, markAsRead, fetchWhatsAppMedia, startTypingIndicator, stopTypingIndicator } from "../../whatsapp.service";
import {
  getOrCreateConversation,
  updateConversation,
  saveCropReport,
  incrementProfileUsage,
} from "../memory.service";
import { logMessage } from "../messages.service";
import { supabase } from "../../db/supabase.service";
import * as gemini from "../gemini.service";
import { Language } from "../gemini.service";
import { sendTextAndLog, sendReplyAndLog } from "../send.service";
import { languageUnknownFallback } from "../language.service";
import { logger } from "../../../utils/logger";
import { checkAndEnforceQuota } from "../../subscription.service";
import { maybeSuggestExpert } from "../expert-suggest.service";

const getStorageBucket = () => process.env.SUPABASE_STORAGE_BUCKET || "crop-images";
const isImageDiagnosisEnabled = () => {
  const v = process.env.ENABLE_IMAGE_DIAGNOSIS;
  if (v === undefined) return true;
  return v === "true" || v === "1";
};

function extensionFromMime(mimeType: string): string {
  const base = (mimeType || "").split(";")[0].trim().toLowerCase();
  const subtype = base.split("/")[1];
  if (!subtype) return "jpg";
  if (subtype === "jpeg") return "jpg";
  return subtype;
}

export async function handleImage(msg: ParsedWhatsAppMessage): Promise<void> {
  if (!msg.mediaId) return;

  markAsRead(msg.messageId).catch(() => {});

  const { conversation, profile } = await getOrCreateConversation(
    msg.from,
    msg.profileName
  );

  if (!conversation.language) {
    await sendTextAndLog(msg.from, languageUnknownFallback(), conversation.id);
    return;
  }
  const lang = conversation.language as Language;

  if (!isImageDiagnosisEnabled()) {
    await sendTextAndLog(msg.from, "> Image diagnosis is currently disabled.", conversation.id);
    return;
  }

  // Quota check before expensive AI processing
  const quota = await checkAndEnforceQuota(msg.from, conversation.id, "image", lang);
  if (!quota.allowed) {
    await sendTextAndLog(msg.from, quota.message!, conversation.id);
    return;
  }

  // Start persistent typing indicator for the entire processing pipeline
  startTypingIndicator(msg.from);
  try {
    // 1. Two-step media fetch from Meta Graph API
    const { buffer, mimeType } = await fetchWhatsAppMedia(msg.mediaId);

    // 2. Upload to Supabase Storage: crop-images/{conversation_id}/{timestamp}.{ext}
    const ts = Date.now();
    const ext = extensionFromMime(mimeType);
    const path = `${conversation.id}/${ts}.${ext}`;

    const { error: upErr } = await supabase.storage
      .from(getStorageBucket())
      .upload(path, buffer, { contentType: mimeType || "image/jpeg", upsert: false });
    if (upErr) {
      logger.error(upErr, "Supabase storage upload failed");
    }

    const { data: pub } = supabase.storage
      .from(getStorageBucket())
      .getPublicUrl(path);
    const imageUrl = pub?.publicUrl ?? null;

    // Log inbound image (now that we have the storage URL for the dashboard)
    await logMessage({
      conversation_id: conversation.id,
      direction: "in",
      type: "image",
      media_url: imageUrl,
      wa_message_id: msg.messageId,
    });

    // 3. Diagnose via Gemini Vision
    const diagnosis = await gemini.diagnoseImage(buffer, mimeType || "image/jpeg", {
      language: lang,
      city: conversation.city,
      cropTypes: profile.crop_types,
      lastCrop: conversation.last_crop,
    });

    // 4. Persist crop report
    await saveCropReport({
      conversation_id: conversation.id,
      crop_type: diagnosis.cropType,
      image_url: imageUrl,
      diagnosis: diagnosis.disease ?? diagnosis.deficiency ?? null,
      treatment: diagnosis.treatment || null,
      confidence: diagnosis.confidence,
      location: conversation.city,
    });

    await incrementProfileUsage(profile.id, "usage_images", 1);

    // 5. Update last_crop if we identified it
    if (diagnosis.cropType) {
      await updateConversation(conversation.id, { last_crop: diagnosis.cropType });
    }

    // 6. Friendly reply
    const reply = await gemini.explainDiagnosisToFarmer(diagnosis, {
      language: lang,
      city: conversation.city,
      cropTypes: profile.crop_types,
    });

    // Append City Chemist upsell when a specific treatment was recommended
    const cityChemistLine: Record<string, string> = {
      english: "_If you are looking to get some of our products, check out City Chemist by Farm Doctor: https://farm-doctor.vercel.app/city-chemist_",
      french:  "_Si vous souhaitez vous procurer certains de nos produits, consultez City Chemist by Farm Doctor\u00a0: https://farm-doctor.vercel.app/city-chemist_",
      pidgin:  "_If you wan get some of our products dem, check City Chemist by Farm Doctor for here: https://farm-doctor.vercel.app/city-chemist_",
    };
    const finalReply = diagnosis.treatment
      ? `${reply}\n\n${cityChemistLine[lang] ?? cityChemistLine.english}`
      : reply;

    await sendReplyAndLog(msg.from, finalReply, lang, false, conversation.id);

    // Image diagnosis is a natural trigger for expert help
    await maybeSuggestExpert(msg.from, conversation.id, conversation.city, lang);
  } finally {
    stopTypingIndicator(msg.from);
  }
}
