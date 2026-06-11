const crypto = require("node:crypto");

// COR-1796: prove WHICH engine API key this CLI holds without revealing it.
//
// The console resolves the signed-in account's key server-side (it has key
// custody via the login JWT), computes the same HMAC, and compares. A
// mismatch means pipelines this agent deploys will not be visible to the
// console account — the root cause behind COR-1795's "Open in deploy" 404s.
//
// Why HMAC keyed with the API key and salted with the session id, instead of
// a bare sha256(key): a stable hash is a correlatable identifier — one leaked
// event log would let an attacker match keys across sessions or precompute
// tables. The per-session HMAC is worthless outside its own session.
export function computeKeyFingerprint(apiKey: string, sessionId: string): string {
  return crypto
    .createHmac("sha256", apiKey)
    .update(sessionId)
    .digest("hex")
    .slice(0, 16);
}

// Local-display-only stable identifier for `auth whoami` / `auth status`, so
// a human can compare two machines' configured keys at a glance. Never
// transmitted — anything sent over the wire must use computeKeyFingerprint.
export function computeKeyIdentity(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}
