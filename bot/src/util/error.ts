/** Human-readable message from an unknown thrown/rejected value. */
export function errorMessage(err: unknown, fallback = "Unknown error"): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const msg = (err as { message: unknown }).message;
    if (typeof msg === "string" && msg) return msg;
  }
  return fallback === "Unknown error" ? String(err) : fallback;
}

/** Node/system error code when present (e.g. `EACCES`). */
export function errorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** HTTP status from axios-style errors (`err.response.status`). */
export function httpStatus(err: unknown): number | undefined {
  if (err && typeof err === "object" && "response" in err) {
    const response = (err as { response?: { status?: unknown } }).response;
    const status = response?.status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}