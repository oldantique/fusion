/** Shared-password login with an HMAC-signed, httpOnly session cookie. */
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { config } from "../config.ts";

const COOKIE = "fusion_session";
const TTL_MS = 30 * 24 * 3600 * 1000;

function sign(payload: string): string {
  return createHmac("sha256", config.cookieSecret).update(payload).digest("base64url");
}

export function issueSession(c: Context) {
  const payload = `${Date.now() + TTL_MS}.${randomBytes(8).toString("hex")}`;
  setCookie(c, COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: TTL_MS / 1000,
    // `secure` is off on purpose: the UI is served over plain HTTP on LAN/Tailscale.
  });
}

export function clearSession(c: Context) {
  deleteCookie(c, COOKIE, { path: "/" });
}

export function isAuthenticated(c: Context): boolean {
  const raw = getCookie(c, COOKIE);
  if (!raw) return false;
  const i = raw.lastIndexOf(".");
  if (i <= 0) return false;
  const payload = raw.slice(0, i);
  const sig = raw.slice(i + 1);
  const expected = sign(payload);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  const exp = Number.parseInt(payload.split(".")[0] ?? "", 10);
  return Number.isFinite(exp) && exp > Date.now();
}

export function passwordMatches(given: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(config.password);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Protects /api/* except the login endpoint. */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  if (isAuthenticated(c)) return next();
  return c.json({ error: "unauthorized" }, 401);
};
