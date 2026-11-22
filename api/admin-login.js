/* Admin login check. Verifies password against ADMIN_PASSWORD_HASH (supports
   both salted scrypt `scrypt$<salt>$<hex>` and legacy 64-char sha256 hex).
   Set ADMIN_PASSWORD_HASH in environment variables to rotate the password. */
const crypto = require("crypto");

const DEFAULT_HASH = "scrypt$5355c1de9f5524615b1345ba95ae0bdc$0ad38a337cf6b01b537952148cfda891dac43c51fd90b52b389e3022adde725c";
const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_MAX_ATTEMPTS = 20;
const attemptsByIp = new Map();

function clientIp(req) {
  const fwd = req.headers && req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim()) return fwd.split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

function isRateLimited(ip) {
  const now = Date.now();
  const entry = attemptsByIp.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    if (attemptsByIp.size > 500) attemptsByIp.clear();
    attemptsByIp.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_MAX_ATTEMPTS;
}

function clearRateLimit(ip) {
  attemptsByIp.delete(ip);
}

function verifyPassword(pass, want) {
  if (!pass || !want || typeof want !== "string") return false;
  const trimmed = want.trim();
  if (trimmed.startsWith("scrypt$")) {
    const parts = trimmed.split("$");
    if (parts.length !== 3 || !parts[1] || !parts[2]) return false;
    try {
      const expected = Buffer.from(parts[2], "hex");
      const derived = crypto.scryptSync(pass, parts[1], expected.length);
      return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
    } catch (e) {
      return false;
    }
  }
  if (/^[a-f0-9]{64}$/i.test(trimmed)) {
    try {
      const got = crypto.createHash("sha256").update(pass, "utf8").digest("hex");
      return crypto.timingSafeEqual(Buffer.from(trimmed.toLowerCase(), "utf8"), Buffer.from(got, "utf8"));
    } catch (e) {
      return false;
    }
  }
  return false;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ ok: false }); return; }

  const ip = clientIp(req);
  if (isRateLimited(ip)) {
    res.status(429).json({ ok: false, error: "too_many_attempts" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const pass = typeof (body && body.password) === "string" ? body.password : "";
  if (!pass || pass.length > 128) {
    res.status(200).json({ ok: false });
    return;
  }

  const want = (process.env.ADMIN_PASSWORD_HASH && process.env.ADMIN_PASSWORD_HASH.trim()) || DEFAULT_HASH;
  const ok = verifyPassword(pass, want);
  if (ok) clearRateLimit(ip);
  res.status(200).json({ ok });
};
