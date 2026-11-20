// One fetch for every outside API: a timeout on every call, and retries with backoff for the failures that go away
// on their own (network drops, timeouts, 429/5xx), honouring Retry-After. Calls that are not safe to repeat
// (creating a comment, posting media) are retried only when the request never reached the server.

const BASE_MS = () => Number(process.env.TUBEDESK_RETRY_BASE_MS || 800);
const sleep = ms => new Promise(r => setTimeout(r, ms));
export const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529]);

/** True for errors where the request may never have left this machine (safe to repeat even for writes). */
function neverSent(err) {
  const code = err?.cause?.code || err?.code || '';
  return ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
}
function retryAfterMs(res) {
  const h = res?.headers?.get?.('retry-after');
  if (!h) return null;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.min(60_000, s * 1000);
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.min(60_000, Math.max(0, t - Date.now())) : null;
}

/**
 * fetchRetry(url, init, { retries, timeoutMs, idempotent, retryStatus })
 * - idempotent (default: GET/HEAD/PUT/DELETE): retry on network errors, timeouts and transient statuses.
 * - not idempotent (POST): retry only when the connection was never made.
 * - retryStatus(res): optional extra check (e.g. YouTube's 403 rateLimitExceeded) — async, may read a clone.
 * Returns the last Response; throws the last network error if every attempt failed to connect.
 */
export async function fetchRetry(url, init = {}, { retries = 3, timeoutMs = 30_000, idempotent, retryStatus } = {}) {
  const method = (init.method || 'GET').toUpperCase();
  const safe = idempotent ?? ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'].includes(method);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const backoff = BASE_MS() * 3 ** attempt * (0.75 + Math.random() * 0.5);
    let res;
    try {
      res = await fetch(url, { ...init, signal: init.signal || AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      lastErr = e;
      const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      if (attempt < retries && (neverSent(e) || (safe && (timeout || e instanceof TypeError)))) { await sleep(backoff); continue; }
      throw e;
    }
    const again = safe && (TRANSIENT_STATUS.has(res.status) || (retryStatus && await retryStatus(res.clone()).catch(() => false)));
    if (!again || attempt === retries) return res;
    await res.arrayBuffer().catch(() => {});
    await sleep(retryAfterMs(res) ?? backoff);
  }
  throw lastErr;
}
