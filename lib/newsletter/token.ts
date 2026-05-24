// Signed one-click unsubscribe tokens. The footer link + List-Unsubscribe
// header both carry a URL like:
//   https://www.goingson.co/api/unsubscribe?u=<userId>&t=<hmac>
// /api/unsubscribe verifies the HMAC against UNSUBSCRIBE_SECRET, flips the
// user's newsletter.subscribed flag to false. No login required — clicking
// the link is itself the authentication. This is required by Gmail/Apple's
// one-click unsubscribe specs (RFC 8058).
//
// Required env: UNSUBSCRIBE_SECRET — any random hex string ≥ 32 chars.
//   Generate locally with: openssl rand -hex 32

import { createHmac, timingSafeEqual } from "node:crypto";

function getSecret(): string {
  const s = process.env.UNSUBSCRIBE_SECRET;
  if (!s || s.length < 16) {
    throw new Error("UNSUBSCRIBE_SECRET env var missing or too short (need ≥16 chars)");
  }
  return s;
}

export function signUnsubscribeToken(userId: string): string {
  const h = createHmac("sha256", getSecret());
  h.update(userId);
  return h.digest("base64url");
}

export function verifyUnsubscribeToken(userId: string, token: string): boolean {
  try {
    const expected = signUnsubscribeToken(userId);
    const a = Buffer.from(expected);
    const b = Buffer.from(token);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function unsubscribeUrl(baseUrl: string, userId: string): string {
  const token = signUnsubscribeToken(userId);
  const url = new URL("/api/unsubscribe", baseUrl);
  url.searchParams.set("u", userId);
  url.searchParams.set("t", token);
  return url.toString();
}
