// Developer portal: self-service consumer API keys.
//
// People sign up on the docs site (Supabase Auth), then call /developer/keys
// with their login access token to create keys of role "consumer". A consumer
// key is NOT an admin credential: it fails every admin route (ROLE_RANK has no
// "consumer" entry, so it ranks 0 and the role gate in authAndRateGate denies
// it). What it does get: 3x the per-route public rate limit (bucketed per key
// instead of per IP) and FHIR scopes (system/*.*, which never covers
// AuditEvent), plus per-key usage counts.

export const CONSUMER_ROLE = "consumer";
export const MAX_KEYS_PER_USER = 3;
export const CONSUMER_RATE_MULTIPLIER = 3;
export const CONSUMER_FHIR_SCOPES = "system/*.*";
export const MAX_LABEL_LENGTH = 60;
export const USAGE_RETENTION_DAYS = 8;

/** Consumer keys get a bigger share of each route's public limit. */
export function consumerRateLimit(baseLimit) {
  return Math.max(1, Math.floor(baseLimit * CONSUMER_RATE_MULTIPLIER));
}

/** Validates the `label` a developer gives a key. Returns { value } or { error }. */
export function validateLabel(raw) {
  const label = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!label) return { error: "'label' is required, e.g. the app or project this key is for" };
  if (label.length > MAX_LABEL_LENGTH) return { error: `'label' must be ${MAX_LABEL_LENGTH} characters or fewer` };
  if (/[<>]/.test(label)) return { error: "'label' must not contain < or >" };
  return { value: label };
}

/** First characters of a raw key, stored so users can tell their keys apart. */
export function keyPrefix(rawKey) {
  return String(rawKey).slice(0, 12);
}

export function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function usageKvKey(keyId, day) {
  return `usage:${keyId}:${day}`;
}

/** The last `n` UTC days ending today, newest first. */
export function recentDays(n = 7, now = new Date()) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(utcDay(new Date(now.getTime() - i * 86400000)));
  return out;
}

/** Best-effort daily counter (KV is not atomic, so counts are approximate). */
export async function bumpUsage(env, keyId, now = new Date()) {
  if (!env.RATE_LIMIT_KV || keyId == null) return;
  const key = usageKvKey(keyId, utcDay(now));
  const current = parseInt((await env.RATE_LIMIT_KV.get(key)) || "0", 10);
  await env.RATE_LIMIT_KV.put(key, String(current + 1), { expirationTtl: USAGE_RETENTION_DAYS * 86400 });
}

export async function readUsage(env, keyId, now = new Date()) {
  if (!env.RATE_LIMIT_KV) return { today: 0, last_7_days: 0 };
  const days = recentDays(7, now);
  const counts = await Promise.all(days.map(async (d) => parseInt((await env.RATE_LIMIT_KV.get(usageKvKey(keyId, d))) || "0", 10) || 0));
  return { today: counts[0], last_7_days: counts.reduce((a, b) => a + b, 0) };
}

/**
 * Per-day counts for the last `n` UTC days, OLDEST first (so a chart reads left to right):
 * [{ day: "2026-10-08", count: 12 }, ...]. Same KV keys and read cost as readUsage().
 */
export async function readUsageDaily(env, keyId, n = 7, now = new Date()) {
  const days = recentDays(n, now).reverse();
  if (!env.RATE_LIMIT_KV) return days.map((day) => ({ day, count: 0 }));
  return Promise.all(days.map(async (day) => ({
    day,
    count: parseInt((await env.RATE_LIMIT_KV.get(usageKvKey(keyId, day))) || "0", 10) || 0,
  })));
}

/**
 * Validates a Supabase Auth access token by asking Supabase who it belongs to.
 * Works with either signing scheme (no JWT secret needed). Returns
 * { ok: true, user: { id, email, emailConfirmed } } or { ok: false, error, status }.
 */
export async function verifySupabaseUser(env, token, fetchImpl = fetch) {
  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) return { ok: false, status: 503, error: "Login is not configured on this deployment" };
  let res;
  try {
    res = await fetchImpl(`${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/user`, {
      headers: { apikey: String(env.SUPABASE_KEY).trim(), Authorization: `Bearer ${token}` },
    });
  } catch {
    return { ok: false, status: 503, error: "Could not reach the login service" };
  }
  if (!res.ok) return { ok: false, status: 401, error: "Your login session is invalid or has expired. Sign in again." };
  const u = await res.json().catch(() => null);
  if (!u?.id || !u.email || u.is_anonymous) return { ok: false, status: 401, error: "A signed-in account with an email address is required" };
  return { ok: true, user: { id: u.id, email: String(u.email).toLowerCase(), emailConfirmed: Boolean(u.email_confirmed_at || u.confirmed_at) } };
}

/** The row stored for a new consumer key (hash only, never the raw key). */
export function buildConsumerKeyRow({ keyHash, label, user, rawKey }) {
  return {
    key_hash: keyHash,
    label,
    role: CONSUMER_ROLE,
    fhir_scopes: CONSUMER_FHIR_SCOPES,
    owner_user_id: user.id,
    owner_email: user.email,
    key_prefix: keyPrefix(rawKey),
  };
}

/** What a developer is allowed to see about their own key. */
export function publicKeyView(row, usage) {
  return {
    id: row.id,
    label: row.label,
    key_prefix: row.key_prefix || null,
    created_at: row.created_at,
    last_used_at: row.last_used_at || null,
    usage: usage || { today: 0, last_7_days: 0 },
  };
}
