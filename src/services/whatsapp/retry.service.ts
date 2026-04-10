import { logger } from "../../utils/logger";

// ─── Per-user cancellation ──────────
const controllers = new Map<string, AbortController>();
let _activeUserId: string | null = null;

export function cancelPending(userId: string): void {
  const prev = controllers.get(userId);
  if (prev) {
    prev.abort();
    logger.info(`[retry] cancelled pending operations for ${userId}`);
  }
}

export function beginProcessing(userId: string): void {
  const ac = new AbortController();
  controllers.set(userId, ac);
  _activeUserId = userId;
}

function getActiveSignal(): AbortSignal | undefined {
  if (!_activeUserId) return undefined;
  return controllers.get(_activeUserId)?.signal;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  {
    attempts = 3,
    delayMs = 1500,
    label = "operation",
    signal,
  }: { attempts?: number; delayMs?: number; label?: string; signal?: AbortSignal } = {}
): Promise<T> {
  const sig = signal ?? getActiveSignal();
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    if (sig?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      return await fn();
    } catch (err) {
      if (sig?.aborted) throw new DOMException("Aborted", "AbortError");
      lastErr = err;
      if (i < attempts) {
        const wait = delayMs * i;
        logger.warn(`[retry] ${label} failed (attempt ${i}/${attempts}), retrying in ${wait}ms`);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, wait);
          sig?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      }
    }
  }
  throw lastErr;
}
