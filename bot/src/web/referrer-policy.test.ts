import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regression guard for the QR-login / cookie-save outage (and in fact every
 * mutating WebUI action). On 2026-05-27 the WebUI-auth feature added the
 * same-origin CSRF gate `app.use("/api", csrfOriginCheck)` in server.ts, and
 * the same day a `<meta name="referrer" content="no-referrer">` was added to
 * web/index.html so cross-origin CDN cover thumbnails would load.
 *
 * Those two changes conflict: per the WHATWG Fetch "Append a request Origin
 * header" algorithm, the `no-referrer` policy sets the Origin header to the
 * literal string "null" on same-origin non-GET requests. csrfOriginCheck then
 * fails to parse a host (`new URL("null")` throws) and returns 403 "bad
 * origin", so POST /api/auth/qrcode (and every other POST/PUT/DELETE under
 * /api/* except /api/session/*) never reaches its handler.
 *
 * `same-origin` is the correct policy: it keeps the real Origin on same-origin
 * requests (CSRF passes) while still sending no Referer cross-origin (CDN
 * thumbnails keep loading). Never switch this back to `no-referrer`.
 */
describe("frontend referrer policy (CSRF / Origin-header regression)", () => {
  const indexHtmlPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../web/index.html"
  );
  const html = fs.readFileSync(indexHtmlPath, "utf-8");

  const referrerMeta = html.match(
    /<meta\s+name=["']referrer["']\s+content=["']([^"']+)["']\s*\/?>/i
  );

  it("declares a referrer policy meta tag", () => {
    expect(referrerMeta).not.toBeNull();
  });

  it("uses same-origin (NOT no-referrer, which sends Origin: null and 403s every POST)", () => {
    expect(referrerMeta?.[1]).toBe("same-origin");
  });

  it("does not contain no-referrer anywhere in the document head", () => {
    expect(html).not.toMatch(/content=["']no-referrer["']/i);
  });
});
