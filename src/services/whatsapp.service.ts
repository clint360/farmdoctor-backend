import { logger } from "../utils/logger";

// ─────────────────────────────────────
// Config
// ─────────────────────────────────────
const getConfig = () => ({
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN || "",
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
  verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || "",
  apiVersion: process.env.WHATSAPP_API_VERSION || "v21.0",
  graphBaseUrl: process.env.WHATSAPP_GRAPH_BASE_URL || "https://graph.facebook.com",
});

function graphBase(): string {
  const c = getConfig();
  return `${c.graphBaseUrl}/${c.apiVersion}`;
}

function authHeader(): Record<string, string> {
  return { Authorization: `Bearer ${getConfig().accessToken}` };
}

// ─────────────────────────────────────
// Types
// ─────────────────────────────────────
export type ParsedWhatsAppMessage = {
  messageId: string;
  from: string;
  timestamp: string;
  type: "text" | "image" | "audio" | "document" | "interactive" | "unsupported";
  text?: string;
  mediaId?: string;
  mimeType?: string;
  profileName?: string;
  interactiveId?: string;
  interactiveTitle?: string;
};

// ─────────────────────────────────────
// Webhook verification (GET)
// ─────────────────────────────────────
export function verifyWebhookChallenge(params: {
  mode: string | null;
  token: string | null;
  challenge: string | null;
}): string | null {
  if (params.mode === "subscribe" && params.token === getConfig().verifyToken) {
    return params.challenge ?? "";
  }
  return null;
}

// ─────────────────────────────────────
// Parse incoming webhook payload
// ─────────────────────────────────────
export function parseWhatsAppPayload(body: unknown): ParsedWhatsAppMessage[] {
  const out: ParsedWhatsAppMessage[] = [];
  const b = body as any;
  const entries = b?.entry ?? [];
  for (const entry of entries) {
    const changes = entry?.changes ?? [];
    for (const change of changes) {
      const value = change?.value ?? {};
      const contacts = value?.contacts ?? [];
      const profileName: string | undefined = contacts[0]?.profile?.name;
      const messages = value?.messages ?? [];
      for (const msg of messages) {
        const base = {
          messageId: String(msg.id ?? ""),
          from: String(msg.from ?? ""),
          timestamp: String(msg.timestamp ?? ""),
          profileName,
        };
        switch (msg.type) {
          case "text":
            out.push({ ...base, type: "text", text: msg.text?.body });
            break;
          case "image":
            out.push({ ...base, type: "image", mediaId: msg.image?.id, mimeType: msg.image?.mime_type });
            break;
          case "audio":
            out.push({ ...base, type: "audio", mediaId: msg.audio?.id, mimeType: msg.audio?.mime_type });
            break;
          case "voice":
            out.push({ ...base, type: "audio", mediaId: msg.voice?.id, mimeType: msg.voice?.mime_type });
            break;
          case "interactive":
            out.push({
              ...base,
              type: "interactive",
              interactiveId: msg.interactive?.list_reply?.id || msg.interactive?.button_reply?.id,
              interactiveTitle: msg.interactive?.list_reply?.title || msg.interactive?.button_reply?.title,
            });
            break;
          default:
            out.push({ ...base, type: "unsupported" });
        }
      }
    }
  }
  return out;
}

// ─────────────────────────────────────
// Media retrieval (two-step Meta flow)
// ─────────────────────────────────────
export async function getMediaDownloadUrl(mediaId: string): Promise<{ url: string; mimeType: string }> {
  const res = await fetch(`${graphBase()}/${mediaId}`, { headers: authHeader() });
  if (!res.ok) {
    throw new Error(`getMediaDownloadUrl failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { url: string; mime_type: string };
  return { url: data.url, mimeType: data.mime_type };
}

export async function downloadMediaBytes(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: authHeader() });
  if (!res.ok) {
    throw new Error(`downloadMediaBytes failed: ${res.status} ${await res.text()}`);
  }
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

export async function fetchWhatsAppMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const { url, mimeType } = await getMediaDownloadUrl(mediaId);
  const buffer = await downloadMediaBytes(url);
  return { buffer, mimeType };
}

// ─────────────────────────────────────
// Send messages
// ─────────────────────────────────────
export async function sendWhatsAppText(to: string, body: string): Promise<void> {
  const c = getConfig();
  const res = await fetch(`${graphBase()}/${c.phoneNumberId}/messages`, {
    method: "POST",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body },
    }),
  });
  if (!res.ok) {
    logger.error({ status: res.status, body: await res.text() }, "sendWhatsAppText failed");
  }
}

export async function sendWhatsAppInteractiveList(
  to: string,
  headerText: string,
  bodyText: string,
  footerText: string,
  buttonLabel: string,
  sections: Array<{
    title: string;
    rows: Array<{ id: string; title: string; description?: string }>;
  }>,
): Promise<void> {
  const c = getConfig();
  const res = await fetch(`${graphBase()}/${c.phoneNumberId}/messages`, {
    method: "POST",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: headerText },
        body: { text: bodyText },
        footer: { text: footerText },
        action: {
          button: buttonLabel,
          sections,
        },
      },
    }),
  });
  if (!res.ok) {
    logger.error({ status: res.status, body: await res.text() }, "sendWhatsAppInteractiveList failed");
  }
}

export async function uploadWhatsAppMedia(buffer: Buffer, mimeType: string, filename: string): Promise<string> {
  const c = getConfig();
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);
  const ab = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(ab).set(buffer);
  form.append("file", new Blob([ab], { type: mimeType }), filename);

  const res = await fetch(`${graphBase()}/${c.phoneNumberId}/media`, {
    method: "POST",
    headers: authHeader(),
    body: form,
  });
  if (!res.ok) {
    throw new Error(`uploadWhatsAppMedia failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { id: string };
  return data.id;
}

export async function sendWhatsAppAudio(to: string, mediaId: string): Promise<void> {
  const c = getConfig();
  const res = await fetch(`${graphBase()}/${c.phoneNumberId}/messages`, {
    method: "POST",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "audio",
      audio: { id: mediaId },
    }),
  });
  if (!res.ok) {
    logger.error({ status: res.status, body: await res.text() }, "sendWhatsAppAudio failed");
  }
}

export async function markAsRead(messageId: string): Promise<void> {
  const c = getConfig();
  try {
    await fetch(`${graphBase()}/${c.phoneNumberId}/messages`, {
      method: "POST",
      headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        typing_indicator: { type: "text" },
      }),
    });
  } catch {
    // best-effort
  }
}

// ─────────────────────────────────────
// Language selection interactive list
// ─────────────────────────────────────
export async function sendLanguageMenu(to: string): Promise<void> {
  await sendWhatsAppInteractiveList(
    to,
    "Welcome to Farm Doctor!",
    "Please select your preferred language to get started:",
    "Powered by Farm Doctor AI",
    "Choose Language",
    [
      {
        title: "Languages",
        rows: [
          { id: "lang_en", title: "English", description: "Get advice in English" },
          { id: "lang_fr", title: "Français", description: "Recevoir des conseils en français" },
          { id: "lang_pidgin", title: "Pidgin", description: "Get advice for Pidgin talk" },
        ],
      },
    ],
  );
}
