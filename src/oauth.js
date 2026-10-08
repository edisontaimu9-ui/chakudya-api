/**
 * OAuth 2.0 (client_credentials grant, RFC 6749 §4.4) helpers.
 *
 * Pure functions only — no DB, no KV, no Request/Response — so they run
 * under `node --test` exactly as they run in the Worker (Web Crypto is a
 * global in both). The HTTP handlers that glue these to Supabase/KV live
 * in index.js (handleOAuthToken, handleAdminOAuthClients, verifyOAuthToken).
 *
 * Access tokens are stateless HS256 JWTs signed with env.OAUTH_SIGNING_SECRET.
 * They carry the client's role, so the existing role gate (ROLE_RANK /
 * requiredRole) applies to them unchanged.
 */

export const OAUTH_TOKEN_TTL_SECONDS = 3600; // 1 hour
export const OAUTH_ROLE_RANK = { reviewer: 1, admin: 2 };

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── base64url ────────────────────────────────────────────────────────────────

function b64urlEncode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const pad = "=".repeat((4 - (str.length % 4)) % 4);
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const b64urlJson = (obj) => b64urlEncode(enc.encode(JSON.stringify(obj)));

async function hmacKey(secret, usages) {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages
  );
}

// ── JWT (HS256 only) ─────────────────────────────────────────────────────────

/** Signs `claims` as an HS256 JWT. */
export async function signJwt(claims, secret) {
  const header = b64urlJson({ alg: "HS256", typ: "JWT" });
  const payload = b64urlJson(claims);
  const data = `${header}.${payload}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, ["sign"]), enc.encode(data));
  return `${data}.${b64urlEncode(new Uint8Array(sig))}`;
}

/** True if the string is shaped like a compact JWT (cheap pre-check, not validation). */
export function looksLikeJwt(token) {
  return typeof token === "string" && /^eyJ[\w-]*\.[\w-]+\.[\w-]+$/.test(token);
}

/**
 * Verifies signature, alg, issuer and expiry.
 * Returns the claims object on success, or null for ANY failure — callers
 * never learn why, so a bad token can't be probed for which check it failed.
 * `alg` is pinned to HS256 (rejects "none" and algorithm-confusion attempts).
 */
export async function verifyJwt(token, secret, { issuer, now = Math.floor(Date.now() / 1000) } = {}) {
  try {
    if (!secret || !looksLikeJwt(token)) return null;
    const [h, p, s] = token.split(".");
    const header = JSON.parse(dec.decode(b64urlDecode(h)));
    if (header.alg !== "HS256") return null;

    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret, ["verify"]),
      b64urlDecode(s),
      enc.encode(`${h}.${p}`)
    );
    if (!valid) return null;

    const claims = JSON.parse(dec.decode(b64urlDecode(p)));
    if (typeof claims.exp !== "number" || claims.exp <= now) return null;
    if (issuer && claims.iss !== issuer) return null;
    if (!claims.sub || !OAUTH_ROLE_RANK[claims.role]) return null;
    return claims;
  } catch {
    return null;
  }
}

// ── Client credentials ───────────────────────────────────────────────────────

/** Random client id/secret pair. Secret is 256 bits (hashed with SHA-256 at rest, like API keys). */
export function generateClientCredentials() {
  const hex = (n) =>
    Array.from(crypto.getRandomValues(new Uint8Array(n)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  return { clientId: `cnr_client_${hex(8)}`, clientSecret: `cnr_secret_${hex(32)}` };
}

/** Length-independent constant-time string compare (for hash comparison). */
export function timingSafeEqual(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

/**
 * Extracts client credentials per RFC 6749 §2.3.1: HTTP Basic (preferred)
 * or client_id/client_secret in the body. `params` is a URLSearchParams or
 * a plain object (JSON body). Returns { clientId, clientSecret, method } or null.
 */
export function parseClientCredentials(authorizationHeader, params) {
  const get = (k) => (params instanceof URLSearchParams ? params.get(k) : params?.[k]);

  const basic = /^Basic\s+(.+)$/i.exec(authorizationHeader || "");
  if (basic) {
    try {
      const decoded = dec.decode(b64urlDecode(basic[1].trim().replace(/=+$/, "")));
      const i = decoded.indexOf(":");
      if (i > 0) {
        return {
          clientId: decodeURIComponent(decoded.slice(0, i).replace(/\+/g, " ")),
          clientSecret: decodeURIComponent(decoded.slice(i + 1).replace(/\+/g, " ")),
          method: "client_secret_basic",
        };
      }
    } catch {
      /* fall through to body credentials */
    }
  }

  const clientId = get("client_id");
  const clientSecret = get("client_secret");
  if (clientId && clientSecret) {
    return { clientId: String(clientId), clientSecret: String(clientSecret), method: "client_secret_post" };
  }
  return null;
}

/**
 * Resolves the scope to grant. Scopes are the role names ("admin",
 * "reviewer"): omitted -> the client's full role; requested -> allowed only
 * if it doesn't exceed the client's role (so an admin client may ask for a
 * narrower "reviewer" token, but never the reverse).
 * Returns { role } or { error: "invalid_scope", description }.
 */
export function resolveScope(clientRole, requestedScope) {
  if (!OAUTH_ROLE_RANK[clientRole]) {
    return { error: "invalid_scope", description: "Client has an unknown role" };
  }
  const requested = String(requestedScope || "").trim();
  if (!requested) return { role: clientRole };

  const wanted = requested.split(/\s+/);
  if (wanted.length > 1 || !OAUTH_ROLE_RANK[wanted[0]]) {
    return { error: "invalid_scope", description: `scope must be one of: ${Object.keys(OAUTH_ROLE_RANK).join(", ")}` };
  }
  if (OAUTH_ROLE_RANK[wanted[0]] > OAUTH_ROLE_RANK[clientRole]) {
    return { error: "invalid_scope", description: `Client is not permitted scope '${wanted[0]}'` };
  }
  return { role: wanted[0] };
}

/** Builds the claim set for a new access token. */
export function buildAccessTokenClaims({ clientId, label, role, issuer, now = Math.floor(Date.now() / 1000) }) {
  return {
    iss: issuer,
    sub: clientId,
    label,
    role,
    scope: role,
    iat: now,
    exp: now + OAUTH_TOKEN_TTL_SECONDS,
    jti: crypto.randomUUID(),
  };
}
