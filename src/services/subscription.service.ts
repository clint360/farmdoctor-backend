import { supabase } from "./db/supabase.service";
import { logger } from "../utils/logger";
import { initDirectPay, getPaymentStatus, FapshiStatus } from "./fapshi.service";

// ─── Plan definitions ───────────────
export interface PlanLimits {
  voice_minutes: number;
  image_analyses: number;
  can_access_experts: boolean;
}

export const PLAN_PRICES: Record<string, number> = {
  starter: 1000,
  pro: 5000,
  cooperative: 15000,
};

export const PLAN_LIMITS: Record<string, PlanLimits> = {
  starter: { voice_minutes: 12, image_analyses: 10, can_access_experts: false },
  pro: { voice_minutes: 60, image_analyses: 30, can_access_experts: true },
  cooperative: { voice_minutes: 300, image_analyses: 50, can_access_experts: true },
};

const FREE_LIMITS: PlanLimits = { voice_minutes: 5, image_analyses: 3, can_access_experts: false };
const FREE_MESSAGE_LIMIT = 20;

export const VALID_PLANS = ["starter", "pro", "cooperative"] as const;
export type PlanName = (typeof VALID_PLANS)[number];

export interface QuotaCheckResult {
  allowed: boolean;
  message?: string;
}

// ─── Quota enforcement ──────────────
export async function checkAndEnforceQuota(
  phone: string,
  conversationId: string,
  messageType: "text" | "voice" | "image",
): Promise<QuotaCheckResult> {
  try {
    const { data: sub } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("phone", phone)
      .eq("status", "active")
      .gte("expires_at", new Date().toISOString())
      .maybeSingle();

    const plan = sub?.plan || "free";
    const limits = PLAN_LIMITS[plan] || FREE_LIMITS;

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    // Free users: count inbound messages this month
    if (plan === "free") {
      const { count: messageCount } = await supabase
        .from("messages")
        .select("*", { count: "exact", head: true })
        .eq("conversation_id", conversationId)
        .eq("direction", "in")
        .gte("created_at", startOfMonth.toISOString());

      if ((messageCount || 0) > FREE_MESSAGE_LIMIT) {
        return {
          allowed: false,
          message: `You've used your ${FREE_MESSAGE_LIMIT} free messages this month. Subscribe to continue!\n\nPlans start at 1,000 XAF/month.\nVisit: https://farm-doctor.vercel.app/subscribe`,
        };
      }
    }

    // Image quota (applies to all plans)
    if (messageType === "image") {
      const { count: imageCount } = await supabase
        .from("messages")
        .select("*", { count: "exact", head: true })
        .eq("conversation_id", conversationId)
        .eq("type", "image")
        .eq("direction", "in")
        .gte("created_at", startOfMonth.toISOString());

      if ((imageCount || 0) >= limits.image_analyses) {
        return {
          allowed: false,
          message: `You've reached your monthly image analysis limit (${limits.image_analyses}). Upgrade your plan for more!\nVisit: https://farm-doctor.vercel.app/subscribe`,
        };
      }
    }

    // Voice minute quota (applies to all plans)
    if (messageType === "voice") {
      const { count: voiceCount } = await supabase
        .from("messages")
        .select("*", { count: "exact", head: true })
        .eq("conversation_id", conversationId)
        .eq("type", "audio")
        .eq("direction", "in")
        .gte("created_at", startOfMonth.toISOString());

      // Avg WhatsApp voice note ≈ 30s → 0.5 min each
      const estimatedMinutes = (voiceCount || 0) * 0.5;
      if (estimatedMinutes >= limits.voice_minutes) {
        return {
          allowed: false,
          message: `You've reached your monthly voice limit (${limits.voice_minutes} minutes). Upgrade your plan for more!\nVisit: https://farm-doctor.vercel.app/subscribe`,
        };
      }
    }

    return { allowed: true };
  } catch (error) {
    logger.error(error, "Error checking quota");
    return { allowed: true };
  }
}

// ─── Get subscription ───────────────
export async function getSubscription(phone: string) {
  const { data } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("phone", phone)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

// ─── Initiate payment via Fapshi ────
export async function initiateSubscriptionPayment(params: {
  phone: string;
  plan: PlanName;
  momo_number: string;
  medium: "mobile money" | "orange money";
}): Promise<{ success: boolean; transId?: string; message: string }> {
  try {
    const amount = PLAN_PRICES[params.plan];
    if (!amount) {
      return { success: false, message: `Unknown plan: ${params.plan}` };
    }

    // Check for existing active subscription — prevent double-subscribe
    const existing = await getSubscription(params.phone);
    if (existing && existing.status === "active" && new Date(existing.expires_at) > new Date()) {
      const currentPlanIndex = VALID_PLANS.indexOf(existing.plan as PlanName);
      const newPlanIndex = VALID_PLANS.indexOf(params.plan);
      if (newPlanIndex <= currentPlanIndex) {
        return {
          success: false,
          message: `You already have an active ${existing.plan} plan until ${new Date(existing.expires_at).toLocaleDateString()}. Choose a higher plan to upgrade.`,
        };
      }
      // Allow upgrade — proceed
    }

    // Initiate Fapshi direct pay
    const fapshiResult = await initDirectPay({
      amount,
      phone: params.momo_number,
      medium: params.medium,
      externalId: `sub_${params.phone}_${Date.now()}`,
      message: `Farm Doctor ${params.plan} plan subscription`,
    });

    // Store payment record
    const { error } = await supabase.from("payments").insert({
      phone: params.phone,
      plan: params.plan,
      amount,
      currency: "XAF",
      momo_number: params.momo_number,
      medium: params.medium,
      fapshi_trans_id: fapshiResult.transId,
      status: "pending",
    });

    if (error) {
      logger.error(error, "Failed to store payment record");
    }

    return {
      success: true,
      transId: fapshiResult.transId,
      message: "Payment request sent to your phone. Please confirm on your device.",
    };
  } catch (error) {
    logger.error(error, "Error initiating subscription payment");
    return { success: false, message: "Failed to initiate payment. Please try again." };
  }
}

// ─── Check payment & activate ───────
export async function checkPaymentAndActivate(transId: string): Promise<{
  status: FapshiStatus;
  activated: boolean;
  message: string;
}> {
  try {
    const fapshiStatus = await getPaymentStatus(transId);

    // Update local payment record
    await supabase
      .from("payments")
      .update({
        status: fapshiStatus.status.toLowerCase(),
        updated_at: new Date().toISOString(),
      })
      .eq("fapshi_trans_id", transId);

    if (fapshiStatus.status === "SUCCESSFUL") {
      // Find the payment record to get phone + plan
      const { data: payment } = await supabase
        .from("payments")
        .select("*")
        .eq("fapshi_trans_id", transId)
        .maybeSingle();

      if (payment) {
        const expiresAt = new Date();
        expiresAt.setMonth(expiresAt.getMonth() + 1);

        await supabase.from("subscriptions").upsert(
          {
            phone: payment.phone,
            plan: payment.plan,
            status: "active",
            payment_method: payment.medium,
            momo_number: payment.momo_number,
            amount: payment.amount,
            currency: "XAF",
            fapshi_trans_id: transId,
            started_at: new Date().toISOString(),
            expires_at: expiresAt.toISOString(),
            updated_at: new Date().toISOString(),
          },
          { onConflict: "phone" },
        );
      }

      return {
        status: "SUCCESSFUL",
        activated: true,
        message: "Payment successful! Your subscription is now active.",
      };
    }

    if (fapshiStatus.status === "FAILED" || fapshiStatus.status === "EXPIRED") {
      return {
        status: fapshiStatus.status,
        activated: false,
        message: `Payment ${fapshiStatus.status.toLowerCase()}. Please try again.`,
      };
    }

    // CREATED or PENDING
    return {
      status: fapshiStatus.status,
      activated: false,
      message: "Payment is still processing. Please confirm on your phone.",
    };
  } catch (error) {
    logger.error(error, "Error checking payment status");
    return { status: "FAILED" as FapshiStatus, activated: false, message: "Error checking payment. Please try again." };
  }
}
