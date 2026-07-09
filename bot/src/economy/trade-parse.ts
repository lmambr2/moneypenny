/**
 * Parse !trade command args into subcommand + flags.
 *
 * Flags: ship:X invest:N stops:N profit:time|pure box:N scu:N loc:Stanton
 *        from:... to:... commodity:X id:N detour:N
 * Multi-word ship names: ship:Freelancer+MAX or ship:"Freelancer MAX" (quotes optional → +)
 */

export type TradeSub = "routes" | "itinerary" | "buyers" | "circuit" | "ships" | "help";

export interface TradeFlags {
  sub: TradeSub;
  /** Free text after sub (commodity name, ship query, etc.). */
  rest: string;
  ship?: string;
  invest?: number;
  stops?: number;
  profit?: "time" | "pure";
  box?: number;
  scu?: number;
  /** Location/system include prefixes. */
  loc: string[];
  from?: string;
  to?: string;
  commodity?: string;
  tradeId?: number;
  detour?: number;
  security?: number;
}

const FLAG_RE =
  /^(ship|invest|investment|stops|profit|box|scu|loc|location|system|from|to|origin|dest|destination|commodity|item|id|trade|detour|security|sec):(.+)$/i;

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).trim();
  }
  // ship:Freelancer+MAX → Freelancer MAX
  return t.replace(/\+/g, " ").trim();
}

export function parseTradeArgs(args: string): TradeFlags {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  let sub: TradeSub = "routes";
  let i = 0;
  if (parts[0]) {
    const s = parts[0].toLowerCase();
    if (
      s === "routes" ||
      s === "route" ||
      s === "itinerary" ||
      s === "itin" ||
      s === "buyers" ||
      s === "buyer" ||
      s === "sell" ||
      s === "circuit" ||
      s === "loop" ||
      s === "ships" ||
      s === "ship" ||
      s === "help" ||
      s === "?"
    ) {
      if (s === "route") sub = "routes";
      else if (s === "itin") sub = "itinerary";
      else if (s === "buyer" || s === "sell") sub = "buyers";
      else if (s === "loop") sub = "circuit";
      else if (s === "ship") sub = "ships";
      else if (s === "?") sub = "help";
      else sub = s as TradeSub;
      i = 1;
    }
  }

  const restParts: string[] = [];
  const loc: string[] = [];
  let ship: string | undefined;
  let invest: number | undefined;
  let stops: number | undefined;
  let profit: "time" | "pure" | undefined;
  let box: number | undefined;
  let scu: number | undefined;
  let from: string | undefined;
  let to: string | undefined;
  let commodity: string | undefined;
  let tradeId: number | undefined;
  let detour: number | undefined;
  let security: number | undefined;

  for (; i < parts.length; i++) {
    const p = parts[i]!;
    const m = FLAG_RE.exec(p);
    if (!m) {
      restParts.push(p);
      continue;
    }
    const key = m[1]!.toLowerCase();
    const val = unquote(m[2]!);
    switch (key) {
      case "ship":
        ship = val;
        break;
      case "invest":
      case "investment": {
        const n = Number(val.replace(/,/g, ""));
        if (!Number.isNaN(n)) invest = n;
        break;
      }
      case "stops": {
        const n = Number(val);
        if (!Number.isNaN(n)) stops = n;
        break;
      }
      case "profit":
        profit = val.toLowerCase().startsWith("p") ? "pure" : "time";
        break;
      case "box": {
        const n = Number(val);
        if (!Number.isNaN(n)) box = n;
        break;
      }
      case "scu": {
        const n = Number(val);
        if (!Number.isNaN(n)) scu = n;
        break;
      }
      case "loc":
      case "location":
      case "system":
        loc.push(val);
        break;
      case "from":
      case "origin":
        from = val;
        break;
      case "to":
      case "dest":
      case "destination":
        to = val;
        break;
      case "commodity":
      case "item":
        commodity = val;
        break;
      case "id":
      case "trade": {
        const n = Number(val);
        if (!Number.isNaN(n)) tradeId = n;
        break;
      }
      case "detour": {
        const n = Number(val);
        if (!Number.isNaN(n)) detour = n;
        break;
      }
      case "security":
      case "sec": {
        const n = Number(val);
        if (!Number.isNaN(n)) security = n;
        break;
      }
      default:
        break;
    }
  }

  return {
    sub,
    rest: restParts.join(" ").trim(),
    ship,
    invest,
    stops,
    profit,
    box,
    scu,
    loc,
    from,
    to,
    commodity,
    tradeId,
    detour,
    security,
  };
}
