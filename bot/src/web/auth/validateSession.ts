import type { SessionStore, SessionValidation } from "../../data/sessions.js";

export const SESSION_COOKIE_NAME = "tsmb_session";

/**
 * Validate the session cookie carried on an arbitrary HTTP-like header bag.
 * Used by Express middleware (req.headers.cookie) AND by the raw WebSocket
 * upgrade handler (req.headers.cookie) — they share this exact behavior.
 */
export function validateSessionFromHeaders(
  rawCookieHeader: string | undefined,
  sessions: SessionStore
): SessionValidation | null {
  if (!rawCookieHeader) return null;
  const token = parseCookie(rawCookieHeader, SESSION_COOKIE_NAME);
  if (!token) return null;
  return sessions.validateAndTouch(token);
}

export function extractSessionToken(rawCookieHeader: string | undefined): string | null {
  if (!rawCookieHeader) return null;
  return parseCookie(rawCookieHeader, SESSION_COOKIE_NAME);
}

function parseCookie(header: string, name: string): string | null {
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    try {
      return decodeURIComponent(trimmed.slice(eq + 1));
    } catch {
      return null;
    }
  }
  return null;
}
