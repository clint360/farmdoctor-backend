import { supabase } from "./db/supabase.service";
import { logger } from "../utils/logger";

export interface InteractionLog {
  user_id: string; // Foreign key linking to users.id
  type: "image" | "text" | "voice";
  crop: string;
  issue: string;
}

export interface InteractionSummary {
  crop: string;
  issue: string;
  lastUserText?: string;
  lastAssistantText?: string;
}

interface InteractionMemory {
  crop: string;
  issue: string;
  lastUserText?: string;
  lastAssistantText?: string;
}

const interactionMemoryByUser = new Map<string, InteractionMemory>();

/**
 * Logs a farmer communication event structurally inside Supabase
 */
export const logInteraction = async (
  payload: InteractionLog,
  memory?: { userText?: string; assistantText?: string },
): Promise<void> => {
  try {
    const { error } = await supabase.from("interactions").insert(payload);
    if (error) {
      throw error;
    }
  } catch (error) {
    logger.error(
      error,
      `Error logging interaction for user ${payload.user_id}`,
    );
  } finally {
    interactionMemoryByUser.set(payload.user_id, {
      crop: payload.crop,
      issue: payload.issue,
      lastUserText: memory?.userText,
      lastAssistantText: memory?.assistantText,
    });
  }
};

export const getLatestInteraction = async (
  userId?: string,
): Promise<InteractionSummary | null> => {
  if (!userId) {
    return null;
  }

  const memory = interactionMemoryByUser.get(userId);

  try {
    const { data, error } = await supabase
      .from("interactions")
      .select("crop, issue")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data && !memory) {
      return null;
    }

    return {
      crop: memory?.crop || data?.crop,
      issue: memory?.issue || data?.issue,
      lastUserText: memory?.lastUserText,
      lastAssistantText: memory?.lastAssistantText,
    };
  } catch (error) {
    logger.error(error, `Error fetching last interaction for user ${userId}`);
    if (!memory) {
      return null;
    }

    return {
      crop: memory.crop,
      issue: memory.issue,
      lastUserText: memory.lastUserText,
      lastAssistantText: memory.lastAssistantText,
    };
  }
};
