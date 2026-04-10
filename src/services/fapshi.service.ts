import { logger } from "../utils/logger";

// ─── Config ─────────────────────────
const getBaseUrl = () => process.env.FAPSHI_BASE_URL || "https://live.fapshi.com";
const getApiUser = () => process.env.FAPSHI_API_USER || "";
const getApiKey = () => process.env.FAPSHI_API_KEY || "";

function headers(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    apiuser: getApiUser(),
    apikey: getApiKey(),
  };
}

// ─── Types ──────────────────────────
export interface DirectPayRequest {
  amount: number;
  phone: string;
  medium?: "mobile money" | "orange money";
  name?: string;
  email?: string;
  userId?: string;
  externalId?: string;
  message?: string;
}

export interface DirectPayResponse {
  message: string;
  transId: string;
  dateInitiated: string;
}

export type FapshiStatus = "CREATED" | "PENDING" | "SUCCESSFUL" | "FAILED" | "EXPIRED";

export interface PaymentStatusResponse {
  transId: string;
  status: FapshiStatus;
  medium: "mobile money" | "orange money";
  serviceName: string;
  amount: number;
  revenue: number;
  payerName: string;
  email: string;
  redirectUrl: string;
  externalId: string;
  userId: string;
  webhook: string;
  financialTransId: string;
  dateInitiated: string;
  dateConfirmed: string;
}

// ─── Helpers ────────────────────────
// Fapshi expects local phone format (e.g. 680612360), not international (237680612360)
function stripCountryCode(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("237") && digits.length > 9) return digits.slice(3);
  return digits;
}

// ─── Direct Pay ─────────────────────
export async function initDirectPay(req: DirectPayRequest): Promise<DirectPayResponse> {
  const url = `${getBaseUrl()}/direct-pay`;
  const cleanPhone = stripCountryCode(req.phone);
  logger.info({ phone: cleanPhone, amount: req.amount, medium: req.medium }, "[fapshi] initiating direct pay");

  const res = await fetch(url, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ ...req, phone: cleanPhone }),
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, body }, "[fapshi] direct-pay failed");
    throw new Error(`Fapshi direct-pay error: ${res.status} ${body}`);
  }

  const data = (await res.json()) as DirectPayResponse;
  logger.info({ transId: data.transId }, "[fapshi] direct-pay initiated");
  return data;
}

// ─── Payment Status ─────────────────
export async function getPaymentStatus(transId: string): Promise<PaymentStatusResponse> {
  const url = `${getBaseUrl()}/payment-status/${transId}`;

  const res = await fetch(url, { headers: headers() });

  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, body }, "[fapshi] payment-status failed");
    throw new Error(`Fapshi payment-status error: ${res.status} ${body}`);
  }

  // Fapshi returns an array with one element
  const data = await res.json();
  const status = Array.isArray(data) ? data[0] : data;
  return status as PaymentStatusResponse;
}
