// upstream_failures: a small per-day counter of failed calls to Cohere, Groq, USDA and FatSecret.
// trackedFetch() is a drop-in for fetch(): a thrown error (network, timeout) or a non-2xx reply bumps one row in
// upstream_failures (per UTC day and service) through bump_upstream_failure(). A reply with no match is not a failure.
// Call sites have no ctx or db in scope, so each write is queued here and the entry points (fetch, scheduled, queue)
// call ctx.waitUntil(flushUpstreamFailures()) so the writes finish after the response is sent. It never throws.
// Storage is off unless UPSTREAM_FAILURES_STORE=true (run sql/035 first). Counts only - no keys, queries or bodies.

export const UPSTREAM_SERVICES = ["cohere", "groq", "usda", "fatsecret"];

const pending = new Set();

export function recordUpstreamFailure(env, service) {
  if (env?.UPSTREAM_FAILURES_STORE !== "true" || !env.SUPABASE_URL || !env.SUPABASE_KEY) return;
  if (!UPSTREAM_SERVICES.includes(service)) return;
  const key = String(env.SUPABASE_KEY).trim();
  const write = Promise.resolve()
    .then(() =>
      fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/bump_upstream_failure`, {
        method: "POST",
        headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ p_service: service }),
      })
    )
    .catch(() => {})
    .finally(() => pending.delete(write));
  pending.add(write);
}

/** Drop-in for fetch(): counts a thrown error or a non-2xx reply against `service`, then returns/rethrows as fetch would. */
export async function trackedFetch(env, service, url, init, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(url, init);
  } catch (e) {
    recordUpstreamFailure(env, service);
    throw e;
  }
  if (!res.ok) recordUpstreamFailure(env, service);
  return res;
}

/** FatSecret can answer 200 with an error body (bad signature, IP, scope). Code 211 is just "no food for this barcode". */
export function isFatSecretError(data) {
  return !!data?.error && Number(data.error.code) !== 211;
}

/** Resolves when every queued write has settled. Pass to ctx.waitUntil(). */
export function flushUpstreamFailures() {
  return Promise.allSettled([...pending]);
}
