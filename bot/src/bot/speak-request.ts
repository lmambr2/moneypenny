/** Max characters sent to TTS for a spoken !ask (Piper will chew on novels). */
export const MAX_ANNOUNCE_CHARS = 900;

/**
 * Detect an explicit request to speak an !ask answer.
 * `-s` / `--say` / `--speak`, leading "say …", or trailing "say it" / "out loud".
 */
export function parseSpokenAskRequest(
  args: string,
  flags: Set<string> = new Set(),
): { text: string; speak: boolean } {
  let text = args.trim();
  let speak = flags.has("s");

  const lead = /^(?:please\s+)?(?:say|speak|read)\s+(?:it\s+)?(?:out\s+loud\s+)?/i;
  const afterLead = text.replace(lead, "").trim();
  if (afterLead && afterLead !== text) {
    speak = true;
    text = afterLead;
  }

  const tail =
    /(?:[,.]?\s+)(?:and\s+)?(?:say|speak|read)\s+it(?:\s+out\s+loud)?$|(?:[,.]?\s+)out\s+loud$|(?:[,.]?\s+)please\s+say\s+it$/i;
  if (tail.test(text)) {
    speak = true;
    text = text.replace(tail, "").trim();
  }

  return { text, speak };
}

/** Flatten markdown/URLs and cap length for Piper. */
export function textForAnnouncement(raw: string, max = MAX_ANNOUNCE_CHARS): string {
  const t = raw
    .replace(/\r\n/g, "\n")
    .replace(/[*_`#]+/g, "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const last = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  const body = (last > 200 ? cut.slice(0, last + 1) : cut).trim();
  return `${body} That's the short version.`;
}
