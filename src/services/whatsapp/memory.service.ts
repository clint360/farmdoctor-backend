import { supabase } from "../db/supabase.service";
import { logger } from "../../utils/logger";

// ─── Types (matching dashboard schema) ───
export type Conversation = {
  id: string;
  phone: string;
  name: string | null;
  language: string | null;
  city: string | null;
  mode: string | null;
  last_crop: string | null;
  platform: string | null;
  created_at: string;
  updated_at: string;
};

export type FarmerProfile = {
  id: string;
  conversation_id: string;
  location: string | null;
  crop_types: string[] | null;
  preferred_language: string | null;
  prefers_voice: boolean;
  usage_images: number;
  usage_voice_minutes: number;
  updated_at: string;
};

// ─── Get or create conversation + profile ───
async function getOrCreateConversationInternal(
  phone: string,
  platform: "whatsapp" | "telegram",
  profileName?: string | null,
): Promise<{
  conversation: Conversation;
  profile: FarmerProfile;
  isNew: boolean;
}> {
  // ── Conversation ────────────────────
  const { data: existing, error: selErr } = await supabase
    .from("conversations")
    .select("*")
    .eq("phone", phone)
    .maybeSingle();
  if (selErr) throw selErr;

  let conversation: Conversation;
  let isNew = false;

  if (existing) {
    conversation = existing as Conversation;
  } else {
    isNew = true;
    const { data, error } = await supabase
      .from("conversations")
      .insert({ phone, name: profileName ?? null, platform })
      .select()
      .single();
    if (error) throw error;
    conversation = data as Conversation;
  }

  // ── Profile ─────────────────────────
  const { data: existingProfile, error: profSelErr } = await supabase
    .from("farmer_profiles")
    .select("*")
    .eq("conversation_id", conversation.id)
    .maybeSingle();
  if (profSelErr) throw profSelErr;

  let profile: FarmerProfile;
  if (existingProfile) {
    profile = existingProfile as FarmerProfile;
  } else {
    const { data, error } = await supabase
      .from("farmer_profiles")
      .insert({ conversation_id: conversation.id, prefers_voice: false })
      .select()
      .single();
    if (error) throw error;
    profile = data as FarmerProfile;
  }

  return { conversation, profile, isNew };
}

export async function getOrCreateConversation(
  phone: string,
  profileName?: string | null,
): Promise<{
  conversation: Conversation;
  profile: FarmerProfile;
  isNew: boolean;
}> {
  return getOrCreateConversationInternal(phone, "whatsapp", profileName);
}

export async function getOrCreateConversationForPlatform(
  phone: string,
  platform: "whatsapp" | "telegram",
  profileName?: string | null,
): Promise<{
  conversation: Conversation;
  profile: FarmerProfile;
  isNew: boolean;
}> {
  return getOrCreateConversationInternal(phone, platform, profileName);
}

// ─── Update helpers ─────────────────
export async function updateConversation(
  id: string,
  patch: Partial<Conversation>,
): Promise<void> {
  const { error } = await supabase
    .from("conversations")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export async function updateProfile(
  id: string,
  patch: Partial<FarmerProfile>,
): Promise<void> {
  const { error } = await supabase
    .from("farmer_profiles")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export async function incrementProfileUsage(
  id: string,
  field: "usage_images" | "usage_voice_minutes",
  by: number = 1,
): Promise<void> {
  const { data } = await supabase
    .from("farmer_profiles")
    .select(field)
    .eq("id", id)
    .maybeSingle();
  const row = data as Record<string, number> | null;
  const current = row?.[field] ?? 0;
  await supabase
    .from("farmer_profiles")
    .update({ [field]: current + by, updated_at: new Date().toISOString() })
    .eq("id", id);
}

// ─── Crop reports ───────────────────
export async function saveCropReport(report: {
  conversation_id: string;
  crop_type: string | null;
  image_url: string | null;
  diagnosis: string | null;
  treatment: string | null;
  confidence: number | null;
  location: string | null;
}): Promise<void> {
  const { error } = await supabase.from("crop_reports").insert(report);
  if (error) {
    logger.error(error, "saveCropReport failed");
    throw error;
  }
}

export async function getLastCropReport(conversationId: string) {
  const { data } = await supabase
    .from("crop_reports")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}
