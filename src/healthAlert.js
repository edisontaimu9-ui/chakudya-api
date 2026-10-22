// Health verdict alert: POSTs to a webhook when the health verdict flips (healthy -> degraded, or back).
// Called from the 5-minute probe (src/healthMonitor.js) with the row that was just built. Off unless ALERT_WEBHOOK_URL is set.
//
// A flip must hold for ALERT_CONFIRM_CHECKS probes in a row (default 2, i.e. about 10 minutes) before it alerts, so one slow
// probe does not page anyone. The last confirmed verdict lives in KV (RATE_LIMIT_KV), not the database, so an outage of the
// database still alerts. If the webhook call fails the state is not advanced, so the next probe tries the alert again.
// The first probe ever seen only records the starting verdict. Without the KV binding nothing can be tracked, so no alerts.
// The message holds statuses, service names and a short error detail. No keys, IPs, queries or bodies.

export const ALERT_STATE_KEY = "health:alert-state";
const STATE_TTL_S = 30 * 86400;
const WEBHOOK_TIMEOUT_MS = 5000;
const DEFAULT_CONFIRM = 2;

function confirmChecks(env) {
  const n = parseInt(env?.ALERT_CONFIRM_CHECKS || "", 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 12) : DEFAULT_CONFIRM;
}

/** Required services that are failing in this row, with the first error detail for each. */
function failingList(row) {
  return Object.entries(row?.services || {})
    .filter(([, s]) => s?.status === "error")
    .map(([name, s]) => (s.detail ? `${name} (${s.detail})` : name));
}

function minutesBetween(fromIso, toIso) {
  const a = new Date(fromIso).getTime();
  const b = new Date(toIso).getTime();
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round((b - a) / 60000)) : null;
}

/** The JSON body. `text` suits Slack-style hooks and `content` Discord; the structured fields suit anything else. */
export function buildAlertPayload(kind, row, since) {
  const failing = failingList(row);
  let text;
  if (kind === "degraded") {
    text = `Chakudya API is DEGRADED${failing.length ? `: ${failing.join(", ")}` : ""}`;
  } else {
    const mins = since ? minutesBetween(since, row.at) : null;
    text = `Chakudya API has RECOVERED${mins != null ? ` after about ${mins} min` : ""}`;
  }
  return {
    text,
    content: text,
    event: kind === "degraded" ? "health.degraded" : "health.recovered",
    status: row.status,
    at: row.at,
    failing_services: failing,
    degraded_since: since || null,
  };
}

async function readState(kv) {
  try {
    const raw = await kv.get(ALERT_STATE_KEY);
    const s = raw ? JSON.parse(raw) : null;
    return s && (s.status === "healthy" || s.status === "degraded") ? s : null;
  } catch (_) {
    return null;
  }
}

async function writeState(kv, state) {
  try { await kv.put(ALERT_STATE_KEY, JSON.stringify(state), { expirationTtl: STATE_TTL_S }); } catch (_) { /* retried next probe */ }
}

async function sendWebhook(url, payload, fetchImpl) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    return !!res && res.ok;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compares this probe's verdict with the last confirmed one and alerts on a confirmed flip.
 * Returns { alerted: "degraded" | "recovered" | null, ... } (mostly for tests). Never throws.
 */
export async function checkVerdictFlip(env, row, fetchImpl = fetch) {
  const url = env?.ALERT_WEBHOOK_URL;
  const kv = env?.RATE_LIMIT_KV;
  if (!url || !kv) return { skipped: true };
  if (!/^https:\/\//i.test(url)) return { skipped: true, reason: "ALERT_WEBHOOK_URL must start with https://" };
  const verdict = row?.status === "degraded" ? "degraded" : "healthy";

  try {
    const state = await readState(kv);
    if (!state) {
      await writeState(kv, { status: verdict, since: row.at });
      return { skipped: false, alerted: null, started: verdict };
    }
    if (verdict === state.status) {
      if (state.pending) await writeState(kv, { status: state.status, since: state.since }); // blip is over; drop the candidate
      return { skipped: false, alerted: null };
    }

    const seen = state.pending && state.pending.status === verdict ? state.pending.count + 1 : 1;
    const needed = confirmChecks(env);
    if (seen < needed) {
      await writeState(kv, { ...state, pending: { status: verdict, count: seen, first_at: state.pending?.first_at || row.at } });
      return { skipped: false, alerted: null, pending: seen, needed };
    }

    // Confirmed flip. The outage began at the first bad probe, which is the better "since" for both messages.
    const flipStart = state.pending && state.pending.status === verdict ? state.pending.first_at : row.at;
    const kind = verdict === "degraded" ? "degraded" : "recovered";
    const payload = buildAlertPayload(kind, row, kind === "recovered" ? state.since : flipStart);
    const sent = await sendWebhook(url, payload, fetchImpl);
    if (!sent) return { skipped: false, alerted: null, failed: true }; // keep the old state so the next probe retries
    await writeState(kv, { status: verdict, since: flipStart });
    return { skipped: false, alerted: kind };
  } catch (_) {
    return { skipped: false, alerted: null, failed: true };
  }
}
