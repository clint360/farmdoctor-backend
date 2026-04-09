import { supabase } from "../db/supabase.service";
import { logger } from "../../utils/logger";

export type MessageRow = {
  id: string;
  conversation_id: string;
  wa_message_id: string | null;
  direction: "in" | "out";
  type: "text" | "image" | "audio" | "document" | "system";
  body: string | null;
  media_url: string | null;
  created_at: string;
};

export async function logMessage(row: {
  conversation_id: string;
  direction: "in" | "out";
  type: MessageRow["type"];
  body?: string | null;
  media_url?: string | null;
  wa_message_id?: string | null;
}): Promise<void> {
  const { error } = await supabase.from("messages").insert({
    conversation_id: row.conversation_id,
    direction: row.direction,
    type: row.type,
    body: row.body ?? null,
    media_url: row.media_url ?? null,
    wa_message_id: row.wa_message_id ?? null,
  });
  if (error) {
    logger.error(error, "logMessage failed");
  }
}

export async function getConversationMessages(
  conversationId: string,
  limit = 500
): Promise<MessageRow[]> {
  const { data } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(limit);
  return (data ?? []) as MessageRow[];
}
