import Retell from "retell-sdk";
import { logger } from "../utils/logger";

const retellApiKey = process.env.RETELL_API_KEY || "";
const retellAgentId = process.env.RETELL_AGENT_ID || "";

let retellClient: Retell | null = null;

function getRetellClient(): Retell {
  if (!retellClient) {
    if (!retellApiKey) {
      throw new Error("RETELL_API_KEY is not configured");
    }
    retellClient = new Retell({ apiKey: retellApiKey });
  }
  return retellClient;
}

/**
 * Create a web call session and return the access token for the client SDK
 */
export async function createWebCall(): Promise<{ access_token: string; call_id: string }> {
  if (!retellAgentId) {
    throw new Error("RETELL_AGENT_ID is not configured");
  }

  const client = getRetellClient();

  const callResponse = await client.call.createWebCall({
    agent_id: retellAgentId,
  });

  logger.info({ callId: callResponse.call_id }, "Retell web call created");

  return {
    access_token: callResponse.access_token,
    call_id: callResponse.call_id,
  };
}
