const ESCAPE_MAP: [string, string][] = [
  ["\\", "\\\\"],
  ["/", "\\/"],
  [" ", "\\s"],
  ["|", "\\p"],
  ["\n", "\\n"],
  ["\r", "\\r"],
  ["\t", "\\t"],
  ["\x07", "\\a"],
  ["\x08", "\\b"],
  ["\x0C", "\\f"],
  ["\x0B", "\\v"],
];

const UNESCAPE_MAP: [string, string][] = ESCAPE_MAP.map(
  ([plain, escaped]) => [escaped, plain] as [string, string]
).reverse();

export function escapeValue(value: string): string {
  let result = value;
  for (const [plain, escaped] of ESCAPE_MAP) {
    result = result.replaceAll(plain, escaped);
  }
  return result;
}

export function unescapeValue(value: string): string {
  let result = value;
  for (const [escaped, plain] of UNESCAPE_MAP) {
    result = result.replaceAll(escaped, plain);
  }
  return result;
}

export function encodeCommand(
  command: string,
  params: Record<string, string | number>
): string {
  const parts = [command];
  for (const [key, value] of Object.entries(params)) {
    parts.push(`${key}=${escapeValue(String(value))}`);
  }
  return parts.join(" ") + "\n";
}

export function decodeResponse(raw: string): Record<string, string>[] {
  const entries = raw.split("|");
  return entries.map((entry) => {
    const result: Record<string, string> = {};
    const pairs = entry.trim().split(" ");
    for (const pair of pairs) {
      const eqIndex = pair.indexOf("=");
      if (eqIndex === -1) {
        result[pair] = "";
      } else {
        const key = pair.substring(0, eqIndex);
        const value = unescapeValue(pair.substring(eqIndex + 1));
        result[key] = value;
      }
    }
    return result;
  });
}

export function parseErrorLine(line: string): { id: number; msg: string } {
  const decoded = decodeResponse(line.replace(/^error\s+/, ""))[0];
  return {
    id: parseInt(decoded.id ?? "0", 10),
    msg: decoded.msg ?? "ok",
  };
}
