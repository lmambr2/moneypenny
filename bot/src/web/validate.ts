/**
 * Zod helpers for Express HTTP boundary validation (audit C4).
 * Prefer these over ad-hoc `typeof` checks on `req.body` / query.
 */

import type { NextFunction, Request, Response } from "express";
import { type ZodType, z } from "zod";

export const zNonEmptyString = z.string().trim().min(1);
export const zOptionalString = z.string().trim().optional();

/** Login/setup username (3–32: alnum, _ - .). */
export const zUsername = z.string().regex(/^[A-Za-z0-9_\-.]{3,32}$/, "invalid username");

/** Password length bounds used by session API. */
export const zPassword = z.string().min(8).max(200);

/** Volume 0–100 (player API; handler may Math.round). */
export const zVolume = z.coerce.number().finite().min(0).max(100);

/** Seek position in seconds (non-negative). */
export const zSeekSeconds = z.coerce.number().finite().min(0);

/** Internal queue play modes (engine). */
export const zQueuePlayMode = z.enum(["sequential", "shuffle", "repeat", "repeat-one"]);

/** Chat `!mode` short tokens used by Player API. */
export const zPlayerModeToken = z.enum(["seq", "loop", "random", "rloop"]);

export type ParseOk<T> = { ok: true; data: T };
export type ParseFail = { ok: false; error: string; details?: unknown };
export type ParseResult<T> = ParseOk<T> | ParseFail;

/** Safe-parse unknown input; returns a stable error string for 400 responses. */
export function parseWithSchema<T>(schema: ZodType<T>, input: unknown): ParseResult<T> {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  const first = result.error.issues[0];
  const path = first?.path?.length ? first.path.join(".") : "";
  const msg = first?.message ?? "invalid input";
  return {
    ok: false,
    error: path ? `${path}: ${msg}` : msg,
    details: result.error.flatten(),
  };
}

/**
 * Express middleware: validate `req.body` with `schema` and assign to `req.body`
 * as the typed output. On failure responds 400 `{ error }`.
 */
export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const parsed = parseWithSchema(schema, req.body ?? {});
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error, code: "VALIDATION_ERROR" });
      return;
    }
    req.body = parsed.data;
    next();
  };
}

/**
 * Validate and return data, or write 400 and return null (handler should return).
 */
export function requireBody<T>(res: Response, schema: ZodType<T>, body: unknown): T | null {
  const parsed = parseWithSchema(schema, body ?? {});
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error, code: "VALIDATION_ERROR" });
    return null;
  }
  return parsed.data;
}
