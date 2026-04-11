import { supabase } from "./db/supabase.service";
import { getExpertsByCity, getAllActiveExperts } from "./expert.service";
import { sendWhatsAppText, sendWhatsAppButtons } from "./whatsapp.service";
import { logger } from "../utils/logger";

// ─── Normalize phone helper ─────────
function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("237") && digits.length === 12) return `+${digits}`;
  if (digits.length === 9) return `+237${digits}`;
  return phone;
}

// ─── Farmer city lookup from conversations table ─────
async function getFarmerCity(phone: string): Promise<string | null> {
  const { data } = await supabase
    .from("conversations")
    .select("city")
    .eq("phone", phone)
    .maybeSingle();
  return data?.city ?? null;
}

// ─── Create missed call record ──────
async function createMissedCall(phone: string, city: string | null): Promise<string> {
  const { data, error } = await supabase
    .from("missed_calls")
    .insert({ phone, city, status: "pending" })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

// ─── Notify experts via WhatsApp ────
async function notifyExperts(
  missedCallId: string,
  farmerPhone: string,
  city: string | null,
): Promise<void> {
  // Find experts near the farmer's city, fall back to all active experts
  let experts = city ? await getExpertsByCity(city) : [];
  if (experts.length === 0) {
    experts = (await getAllActiveExperts()).map((e) => ({
      full_name: e.full_name,
      phone: e.phone,
      location: e.location,
    }));
  }
  if (experts.length === 0) {
    logger.warn({ missedCallId, farmerPhone }, "No experts to notify for missed call");
    return;
  }

  // Look up expert IDs for the claim records
  const { data: expertRows } = await supabase
    .from("experts")
    .select("id, phone")
    .in("phone", experts.map((e) => e.phone));

  const phoneToId = new Map<string, string>();
  for (const row of expertRows ?? []) {
    phoneToId.set(row.phone, row.id);
  }

  for (const expert of experts) {
    const expertId = phoneToId.get(expert.phone);
    if (!expertId) continue;

    // Insert claim record (notified status) — skip duplicates
    try {
      await supabase.from("expert_claims").insert({
        missed_call_id: missedCallId,
        expert_id: expertId,
        expert_phone: expert.phone,
        status: "notified",
      });
    } catch { /* duplicate — skip */ }

    // Build the notification message
    const msg = [
      "🚨 *Emergency Expert Help Needed*",
      "",
      `A farmer needs urgent assistance!`,
      "",
      `📞 *Farmer:* ${farmerPhone}`,
      city ? `📍 *Location:* ${city}` : "",
      "",
      `You are being contacted because you are a verified Farm Doctor expert${city ? ` near *${city}*` : ""}.`,
      "",
      "_Please respond quickly — the farmer is waiting._",
    ].filter(Boolean).join("\n");

    try {
      await sendWhatsAppButtons(expert.phone, msg, [
        { id: `claim_yes_${missedCallId}`, title: "🤝 I'll Help" },
        { id: `claim_no_${missedCallId}`, title: "❌ Not Available" },
      ]);
      logger.info({ expertPhone: expert.phone, missedCallId }, "Expert notified for missed call");
    } catch (err) {
      logger.error(err, `Failed to notify expert ${expert.phone}`);
    }
  }
}

// ─── Main: process a missed call ────
export async function processMissedCall(phone: string): Promise<{ success: boolean; missedCallId?: string }> {
  try {
    const normalized = normalizePhone(phone);
    const city = await getFarmerCity(normalized);
    const missedCallId = await createMissedCall(normalized, city);

    logger.info({ phone: normalized, city, missedCallId }, "Missed call recorded");

    // Notify experts (fire-and-forget so the API responds fast)
    notifyExperts(missedCallId, normalized, city).catch((err) => {
      logger.error(err, "Failed to notify experts for missed call");
    });

    return { success: true, missedCallId };
  } catch (error) {
    logger.error(error, "processMissedCall failed");
    return { success: false };
  }
}

// ─── Handle expert claim response (from WhatsApp interactive buttons) ────
export async function handleExpertClaim(
  expertPhone: string,
  missedCallId: string,
  accepted: boolean,
): Promise<void> {
  try {
    // Get the claim record
    const { data: claim } = await supabase
      .from("expert_claims")
      .select("*, missed_calls(*)")
      .eq("missed_call_id", missedCallId)
      .eq("expert_phone", expertPhone)
      .maybeSingle();

    if (!claim) {
      logger.warn({ expertPhone, missedCallId }, "No claim record found");
      return;
    }

    const missedCall = claim.missed_calls;

    // If already claimed by another expert
    if (missedCall.status === "claimed") {
      await sendWhatsAppText(
        expertPhone,
        "✅ This farmer has already been connected with another expert. Thank you for your willingness to help!"
      );
      return;
    }

    if (!accepted) {
      // Mark this expert's claim as declined
      await supabase
        .from("expert_claims")
        .update({ status: "declined", responded_at: new Date().toISOString() })
        .eq("missed_call_id", missedCallId)
        .eq("expert_phone", expertPhone);

      await sendWhatsAppText(
        expertPhone,
        "Got it — no worries! We'll find another expert. Thank you. 🙏"
      );
      return;
    }

    // ── Expert accepted ──
    // Mark the missed call as claimed
    const { data: expertRow } = await supabase
      .from("experts")
      .select("id, full_name")
      .eq("phone", expertPhone)
      .maybeSingle();

    if (!expertRow) return;

    await supabase
      .from("missed_calls")
      .update({
        status: "claimed",
        claimed_by_expert: expertRow.id,
        claimed_at: new Date().toISOString(),
      })
      .eq("id", missedCallId);

    await supabase
      .from("expert_claims")
      .update({ status: "accepted", responded_at: new Date().toISOString() })
      .eq("missed_call_id", missedCallId)
      .eq("expert_phone", expertPhone);

    // Confirm to the expert who accepted
    await sendWhatsAppText(
      expertPhone,
      [
        "🎉 *You've been connected!*",
        "",
        `Thank you, *${expertRow.full_name}*!`,
        "",
        `📞 *Farmer's number:* ${missedCall.phone}`,
        missedCall.city ? `📍 *Location:* ${missedCall.city}` : "",
        "",
        "Please reach out to the farmer as soon as possible.",
        "They are expecting your call. 🌱",
      ].filter(Boolean).join("\n"),
    );

    // Notify farmer that an expert will contact them
    try {
      await sendWhatsAppText(
        missedCall.phone,
        [
          "🌟 *Great news!*",
          "",
          `An agricultural expert (*${expertRow.full_name}*) will be contacting you shortly to help with your farming needs.`,
          "",
          `📞 Expert's number: ${expertPhone}`,
          "",
          "Feel free to share details about your crop issue when they call. 🌱",
        ].join("\n"),
      );
    } catch {
      // Non-critical
    }

    // Notify other experts that this farmer has been claimed
    const { data: otherClaims } = await supabase
      .from("expert_claims")
      .select("expert_phone")
      .eq("missed_call_id", missedCallId)
      .neq("expert_phone", expertPhone)
      .eq("status", "notified");

    for (const other of otherClaims ?? []) {
      try {
        await sendWhatsAppText(
          other.expert_phone,
          [
            "✅ *Update: Farmer Connected*",
            "",
            `The farmer (${missedCall.phone}) has been claimed by another expert.`,
            "",
            "Thank you for your availability! 🙏",
          ].join("\n"),
        );

        // Mark as expired
        await supabase
          .from("expert_claims")
          .update({ status: "expired", responded_at: new Date().toISOString() })
          .eq("missed_call_id", missedCallId)
          .eq("expert_phone", other.expert_phone);
      } catch {
        // Non-critical
      }
    }

    logger.info({ missedCallId, expertPhone, farmerPhone: missedCall.phone }, "Expert claimed missed call");
  } catch (error) {
    logger.error(error, "handleExpertClaim failed");
  }
}
