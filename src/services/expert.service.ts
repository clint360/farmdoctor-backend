import { supabase } from "./db/supabase.service";
import { logger } from "../utils/logger";
import { initDirectPay, getPaymentStatus, FapshiStatus } from "./fapshi.service";

export const EXPERT_FEE = 25000; // XAF per year

export interface ExpertApplication {
  full_name: string;
  phone: string;
  location: string;
  linkedin?: string | null;
  cover_letter: string;
  momo_number: string;
  medium: "mobile money" | "orange money";
}

/**
 * Submit expert application and initiate Fapshi payment
 */
export async function applyAsExpert(application: ExpertApplication): Promise<{
  success: boolean;
  message: string;
  transId?: string;
}> {
  try {
    // Check for existing active expert
    const { data: existing } = await supabase
      .from("experts")
      .select("id, status, subscription_expires_at")
      .eq("phone", application.phone)
      .maybeSingle();

    if (existing && existing.status === "active" && new Date(existing.subscription_expires_at) > new Date()) {
      return {
        success: false,
        message: `You already have an active expert listing until ${new Date(existing.subscription_expires_at).toLocaleDateString()}.`,
      };
    }

    // Initiate Fapshi direct pay
    const fapshiResult = await initDirectPay({
      amount: EXPERT_FEE,
      phone: application.momo_number,
      medium: application.medium,
      externalId: `expert_${application.phone}_${Date.now()}`,
      message: "Farm Doctor Expert Annual Subscription",
    });

    // Upsert expert record (pending payment)
    const { error } = await supabase.from("experts").upsert(
      {
        full_name: application.full_name,
        phone: application.phone,
        location: application.location.toLowerCase().trim(),
        linkedin: application.linkedin || null,
        cover_letter: application.cover_letter,
        momo_number: application.momo_number,
        medium: application.medium,
        amount_paid: EXPERT_FEE,
        currency: "XAF",
        status: "pending_payment",
        fapshi_trans_id: fapshiResult.transId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "phone" },
    );

    if (error) throw error;

    // Store payment record
    await supabase.from("payments").insert({
      phone: application.phone,
      plan: "expert",
      amount: EXPERT_FEE,
      currency: "XAF",
      momo_number: application.momo_number,
      medium: application.medium,
      fapshi_trans_id: fapshiResult.transId,
      status: "pending",
    });

    logger.info({ phone: application.phone, transId: fapshiResult.transId }, "Expert application + payment initiated");
    return {
      success: true,
      transId: fapshiResult.transId,
      message: "Payment request sent to your phone. Please confirm on your device.",
    };
  } catch (error) {
    logger.error(error, "Error in expert application");
    return { success: false, message: "Failed to submit application. Please try again." };
  }
}

/**
 * Check expert payment status and activate if successful
 */
export async function checkExpertPaymentAndActivate(transId: string): Promise<{
  status: FapshiStatus;
  activated: boolean;
  message: string;
}> {
  try {
    const fapshiStatus = await getPaymentStatus(transId);

    // Update payment record
    await supabase
      .from("payments")
      .update({ status: fapshiStatus.status.toLowerCase(), updated_at: new Date().toISOString() })
      .eq("fapshi_trans_id", transId);

    if (fapshiStatus.status === "SUCCESSFUL") {
      const expiresAt = new Date();
      expiresAt.setFullYear(expiresAt.getFullYear() + 1);

      await supabase
        .from("experts")
        .update({
          status: "active",
          subscription_expires_at: expiresAt.toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("fapshi_trans_id", transId);

      return { status: "SUCCESSFUL", activated: true, message: "Payment successful! Your expert profile is now active." };
    }

    if (fapshiStatus.status === "FAILED" || fapshiStatus.status === "EXPIRED") {
      await supabase
        .from("experts")
        .update({ status: "payment_failed", updated_at: new Date().toISOString() })
        .eq("fapshi_trans_id", transId);

      return { status: fapshiStatus.status, activated: false, message: `Payment ${fapshiStatus.status.toLowerCase()}. Please try again.` };
    }

    return { status: fapshiStatus.status, activated: false, message: "Payment is still processing. Please confirm on your phone." };
  } catch (error) {
    logger.error(error, "Error checking expert payment status");
    return { status: "FAILED" as FapshiStatus, activated: false, message: "Error checking payment. Please try again." };
  }
}

/**
 * Get active experts near a given city
 */
export async function getExpertsByCity(city: string): Promise<Array<{ full_name: string; phone: string; location: string }>> {
  try {
    const normalizedCity = city.toLowerCase().trim();
    const { data, error } = await supabase
      .from("experts")
      .select("full_name, phone, location")
      .eq("status", "active")
      .gte("subscription_expires_at", new Date().toISOString())
      .ilike("location", `%${normalizedCity}%`);

    if (error) throw error;
    return data || [];
  } catch (error) {
    logger.error(error, "Error fetching experts by city");
    return [];
  }
}

/**
 * Get all active experts
 */
export async function getAllActiveExperts(): Promise<any[]> {
  try {
    const { data, error } = await supabase
      .from("experts")
      .select("*")
      .eq("status", "active")
      .gte("subscription_expires_at", new Date().toISOString());

    if (error) throw error;
    return data || [];
  } catch (error) {
    logger.error(error, "Error fetching all experts");
    return [];
  }
}
