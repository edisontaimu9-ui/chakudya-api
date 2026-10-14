// GET /admin/activity (root admin key only) - recent admin actions for the admin monitor page.
// Derived from data the API already stores, so it needs no new table and no SQL:
//   - API keys created and revoked (api_keys.created_at / revoked_at; developer self-service keys excluded)
//   - packaged-food submissions approved or rejected (packaged_foods.reviewed_at / reviewed_by / rejection_reason)
// Key changes carry no actor because the API does not record one; reviews carry reviewed_by.
// Never returns key hashes or raw keys. Nothing here writes.

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

function limitOf(url) {
  const n = parseInt(url.searchParams.get("limit") || "", 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

export function buildKeyEvents(rows) {
  const events = [];
  for (const k of rows) {
    if (k.owner_user_id) continue; // developer self-service keys are not admin actions
    const subject = k.label || `key #${k.id}`;
    const detail = `role ${k.role || "admin"}`;
    if (k.created_at) events.push({ type: "key_created", at: k.created_at, actor: null, subject, detail, ref: String(k.id) });
    if (k.revoked_at) events.push({ type: "key_revoked", at: k.revoked_at, actor: null, subject, detail, ref: String(k.id) });
  }
  return events;
}

export function buildReviewEvents(rows) {
  return rows
    .filter((r) => r.reviewed_at && (r.status === "approved" || r.status === "rejected"))
    .map((r) => ({
      type: r.status === "approved" ? "packaged_approved" : "packaged_rejected",
      at: r.reviewed_at,
      actor: r.reviewed_by || null,
      subject: r.product_name || `packaged food #${r.id}`,
      detail: r.status === "rejected" && r.rejection_reason ? r.rejection_reason : [r.brand, r.barcode].filter(Boolean).join(" · "),
      ref: String(r.id),
    }));
}

export async function handleAdminActivity(request, db, { success, err }) {
  if (request.method !== "GET") return err("Method not allowed", 405);
  const url = new URL(request.url);
  const limit = limitOf(url);

  const [keys, reviews] = await Promise.all([
    db.select("api_keys", {
      filters: {},
      select: "id,label,role,created_at,revoked_at,owner_user_id",
      order: "created_at.desc",
      limit: 200,
    }).catch(() => null),
    db.select("packaged_foods", {
      filters: { reviewed_at: "not.is.null" },
      select: "id,product_name,brand,barcode,status,reviewed_at,reviewed_by,rejection_reason",
      order: "reviewed_at.desc",
      limit: 100,
    }).catch(() => null),
  ]);

  const keyRows = keys && keys.ok && Array.isArray(keys.body) ? keys.body : [];
  const reviewRows = reviews && reviews.ok && Array.isArray(reviews.body) ? reviews.body : [];

  const events = [...buildKeyEvents(keyRows), ...buildReviewEvents(reviewRows)]
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, limit);

  return success({
    generated_at: new Date().toISOString(),
    sources: { api_keys: !!(keys && keys.ok), packaged_reviews: !!(reviews && reviews.ok) },
    events,
  });
}
