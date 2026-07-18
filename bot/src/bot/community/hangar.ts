import {
  callsignOwnerKey,
  type HangarShip,
  shipIdFromName,
  type UserShipsStore,
  uidOwnerKey,
} from "../../data/user-ships.js";
import { fuzzyBestMatch } from "../../economy/fuzzy.js";
import type { Logger } from "../../logger.js";
import type { MemPalaceClient } from "../../memory/mempalace-client.js";
import {
  generateShipListMarkdown,
  parseShipListMarkdown,
  type ShipListExportRow,
} from "./hangar-ship-list.js";

export interface HangarChannelClient {
  uid?: string;
  nickname?: string;
  id?: number;
}

export interface HangarServiceDeps {
  store: UserShipsStore;
  mempalace?: MemPalaceClient | null;
  mempalaceEnabled?: () => boolean;
  /** Optional catalog names for fuzzy resolve (SC Trade, etc.). */
  catalogShipNames?: () => Promise<string[]> | string[];
  /** Read doctrine Ship_List.md body (null if missing). */
  readShipList?: () => string | null;
  /** Write Ship_List.md (doctrine). */
  writeShipList?: (markdown: string) => void;
  logger?: Logger;
}

const HELP = `Hangar commands:
  !ships / !ships list — your hangar
  !ships add <name> [xN][, name…] — add (qty optional)
  !ships remove <name> [xN] — remove qty
  !ships set <name>, … — replace your hangar
  !ships clear — empty your hangar
  !ships have <name> — do you own it?
  !ships claim <CODE> — claim a Ship_List callsign hangar (e.g. GCV)
  !ships link <CODE> — set your callsign without moving ships
Colonel / Chairman (ships.org):
  !ships org — org summary
  !ships org who <ship> — who owns this hull
  !ships org of <nick|CODE|uid> — one hangar
  !ships org list — all hangars (capped)
  !ships add for <target> <name>… — edit another's hangar
  !ships remove for <target> <name>
  !ships import — seed from doctrine Ship_List.md
  !ships export — rewrite Ship_List.md from hangar DB (run !reindex after)`;

/**
 * Personal hangars + org rollup (Colonel/Chairman via ships.org).
 * Private by default; Ship_List.md is the secret doctrine RAG projection.
 */
export class HangarService {
  constructor(private deps: HangarServiceDeps) {}

  async handle(
    args: string,
    invokerUid: string | undefined,
    canRun: ((token: string) => boolean) | undefined,
    clients: HangarChannelClient[] = [],
  ): Promise<string> {
    const raw = (args ?? "").trim();
    if (!raw || /^help$/i.test(raw)) return HELP;

    const orgOk = !!canRun?.("ships.org");
    const parts = splitArgs(raw);
    const head = (parts[0] ?? "").toLowerCase();

    if (head === "org") {
      if (!orgOk) return "○ That needs Colonel or Chairman (ships.org).";
      return this.handleOrg(parts.slice(1), clients);
    }

    if (head === "import") {
      if (!orgOk) return "○ That needs Colonel or Chairman (ships.org).";
      return this.importShipList();
    }

    if (head === "export") {
      if (!orgOk) return "○ That needs Colonel or Chairman (ships.org).";
      return this.exportShipList();
    }

    // !ships add for <target> …
    if (
      (head === "add" || head === "remove" || head === "set" || head === "clear") &&
      parts[1]?.toLowerCase() === "for"
    ) {
      if (!orgOk) return "○ Editing another hangar needs Colonel or Chairman (ships.org).";
      const targetTok = parts[2];
      if (!targetTok) return `Usage: !ships ${head} for <nick|CODE|uid> …`;
      const owner = this.resolveOwner(targetTok, clients);
      if (!owner) return `Couldn't resolve hangar target '${targetTok}'.`;
      if (head === "clear") {
        const n = this.deps.store.clearShips(owner.ownerKey);
        await this.syncMemPalaceHangar(owner.ownerKey);
        this.maybeExportHint();
        return `Cleared ${n} hull type(s) for ${owner.label}.`;
      }
      const rest = parts.slice(3).join(" ");
      if (head === "add") return this.addShips(owner.ownerKey, owner.label, rest);
      if (head === "remove") return this.removeShips(owner.ownerKey, owner.label, rest);
      return this.setShips(owner.ownerKey, owner.label, rest);
    }

    if (!invokerUid) return "Couldn't identify you — nothing saved.";
    const self = this.deps.store.ensureUidProfile(invokerUid);
    const selfKey = self.ownerKey;

    if (head === "list" || head === "ls") {
      return this.formatHangar(selfKey, "Your hangar");
    }
    if (head === "claim") {
      const code = parts[1];
      if (!code) return "Usage: !ships claim <CALLSIGN>  (e.g. !ships claim GCV)";
      return this.claimCallsign(invokerUid, code, clients);
    }
    if (head === "link") {
      const code = parts[1];
      if (!code) return "Usage: !ships link <CALLSIGN>";
      this.deps.store.upsertProfile({
        ownerKey: selfKey,
        uid: invokerUid,
        callsign: code.toUpperCase(),
      });
      return `Linked callsign **${code.toUpperCase()}** to your hangar.`;
    }
    if (head === "have" || head === "has") {
      const q = parts.slice(1).join(" ");
      if (!q) return "Usage: !ships have <name>";
      return this.haveShip(selfKey, q);
    }
    if (head === "clear") {
      const n = this.deps.store.clearShips(selfKey);
      await this.syncMemPalaceHangar(selfKey);
      return n > 0 ? `Cleared your hangar (${n} hull type(s)).` : "Your hangar was already empty.";
    }
    if (head === "add") {
      return this.addShips(selfKey, "your hangar", parts.slice(1).join(" "));
    }
    if (head === "remove" || head === "rm" || head === "del") {
      return this.removeShips(selfKey, "your hangar", parts.slice(1).join(" "));
    }
    if (head === "set") {
      return this.setShips(selfKey, "your hangar", parts.slice(1).join(" "));
    }

    // Bare !ships with no subcommand → list; if looks like add payload, treat as add
    if (!head || head === "mine" || head === "hangar") {
      return this.formatHangar(selfKey, "Your hangar");
    }
    // `!ships Prospector` → have?
    if (parts.length === 1) return this.haveShip(selfKey, parts[0]!);
    return HELP;
  }

  private async handleOrg(args: string[], clients: HangarChannelClient[]): Promise<string> {
    const sub = (args[0] ?? "summary").toLowerCase();
    if (sub === "who") {
      const q = args.slice(1).join(" ").trim();
      if (!q) return "Usage: !ships org who <ship name>";
      const hits = this.deps.store.ownersWithShip(q);
      if (hits.length === 0) return `No hangar entries matching '${q}'.`;
      const lines = hits.slice(0, 40).map((h) => {
        const who = formatOwnerLabel(h);
        return `• ${who}: ${h.matchedShipName} ×${h.shipQty}`;
      });
      const more = hits.length > 40 ? `\n… +${hits.length - 40} more` : "";
      return `Org hangars — **${q}**:\n${lines.join("\n")}${more}`;
    }
    if (sub === "of") {
      const tok = args.slice(1).join(" ").trim();
      if (!tok) return "Usage: !ships org of <nick|CODE|uid>";
      const owner = this.resolveOwner(tok, clients);
      if (!owner) return `Couldn't resolve '${tok}'.`;
      return this.formatHangar(owner.ownerKey, `Hangar — ${owner.label}`);
    }
    if (sub === "list") {
      const profiles = this.deps.store
        .listProfiles()
        .filter((p) => this.deps.store.listShips(p.ownerKey).length > 0);
      if (profiles.length === 0)
        return "No hangars on file yet. Members: !ships add … or Colonel: !ships import";
      const cap = 30;
      const lines: string[] = [];
      for (const p of profiles.slice(0, cap)) {
        const ships = this.deps.store.listShips(p.ownerKey);
        const hulls = ships.reduce((n, s) => n + s.qty, 0);
        lines.push(`• ${formatOwnerLabel(p)} — ${hulls} hull(s), ${ships.length} type(s)`);
      }
      const more = profiles.length > cap ? `\n… +${profiles.length - cap} members` : "";
      return `Org hangars (${profiles.length} members):\n${lines.join("\n")}${more}`;
    }
    // summary
    const all = this.deps.store.allShipsWithProfiles();
    if (all.length === 0) return "Org hangars empty. Try !ships import from Ship_List.md.";
    const members = new Set(all.map((s) => s.ownerKey));
    const totalHulls = all.reduce((n, s) => n + s.qty, 0);
    const byName = new Map<string, number>();
    for (const s of all) byName.set(s.shipName, (byName.get(s.shipName) ?? 0) + s.qty);
    const top = [...byName.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([n, c]) => `${n} (${c})`)
      .join(", ");
    return [
      `Org hangars: **${members.size}** members · **${totalHulls}** hulls · **${byName.size}** types`,
      top ? `Top: ${top}` : "",
      `Commands: !ships org who|of|list · !ships import · !ships export`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  private async addShips(ownerKey: string, label: string, rest: string): Promise<string> {
    const specs = parseShipSpecs(rest);
    if (specs.length === 0) return "Usage: !ships add <name> [x2][, name…]";
    const warnings: string[] = [];
    const added: string[] = [];
    for (const spec of specs) {
      const resolved = await this.resolveShipName(spec.name);
      if (!resolved.catalogMatched) {
        warnings.push(`'${resolved.name}' not in catalog — stored with warning`);
      }
      const row = this.deps.store.addShip({
        ownerKey,
        shipId: resolved.shipId,
        shipName: resolved.name,
        qty: spec.qty,
        catalogMatched: resolved.catalogMatched,
      });
      added.push(`${row.shipName} ×${row.qty}`);
    }
    await this.syncMemPalaceHangar(ownerKey);
    const warn = warnings.length ? `\n⚠ ${warnings.join("; ")}` : "";
    return `Updated ${label}: ${added.join(", ")}.${warn}`;
  }

  private async removeShips(ownerKey: string, label: string, rest: string): Promise<string> {
    const specs = parseShipSpecs(rest);
    if (specs.length === 0) return "Usage: !ships remove <name> [x2]";
    const notes: string[] = [];
    for (const spec of specs) {
      const resolved = await this.resolveShipName(spec.name);
      const existing =
        this.deps.store.getShip(ownerKey, resolved.shipId) ??
        this.findShipFuzzy(ownerKey, spec.name);
      if (!existing) {
        notes.push(`no ${spec.name}`);
        continue;
      }
      const r = this.deps.store.removeShip(ownerKey, existing.shipId, spec.qty);
      if (r === "removed") notes.push(`removed ${existing.shipName}`);
      else if (r === "decremented") {
        const left = this.deps.store.getShip(ownerKey, existing.shipId);
        notes.push(`${existing.shipName} now ×${left?.qty ?? 0}`);
      }
    }
    await this.syncMemPalaceHangar(ownerKey);
    return `Updated ${label}: ${notes.join("; ") || "nothing changed"}.`;
  }

  private async setShips(ownerKey: string, label: string, rest: string): Promise<string> {
    const specs = parseShipSpecs(rest);
    if (specs.length === 0) return "Usage: !ships set <name> [x2][, name…]";
    this.deps.store.clearShips(ownerKey);
    const warnings: string[] = [];
    for (const spec of specs) {
      const resolved = await this.resolveShipName(spec.name);
      if (!resolved.catalogMatched) warnings.push(resolved.name);
      this.deps.store.setShip({
        ownerKey,
        shipId: resolved.shipId,
        shipName: resolved.name,
        qty: spec.qty,
        catalogMatched: resolved.catalogMatched,
      });
    }
    await this.syncMemPalaceHangar(ownerKey);
    const hangar = this.formatHangar(ownerKey, label);
    const warn = warnings.length
      ? `\n⚠ Not in catalog (stored anyway): ${warnings.join(", ")}`
      : "";
    return `${hangar}${warn}`;
  }

  private haveShip(ownerKey: string, query: string): string {
    const ships = this.deps.store.listShips(ownerKey);
    if (ships.length === 0) return "Hangar empty.";
    const hit = this.findShipFuzzy(ownerKey, query);
    if (!hit) return `No — nothing matching '${query}' in hangar.`;
    return `Yes — **${hit.shipName}** ×${hit.qty}${hit.catalogMatched ? "" : " (uncatalogued)"}.`;
  }

  private findShipFuzzy(ownerKey: string, query: string): HangarShip | null {
    const ships = this.deps.store.listShips(ownerKey);
    const best = fuzzyBestMatch(query, ships, (s) => [s.shipName, s.shipId], { minScore: 45 });
    return best ?? null;
  }

  private formatHangar(ownerKey: string, title: string): string {
    const ships = this.deps.store.listShips(ownerKey);
    const profile = this.deps.store.getProfile(ownerKey);
    if (ships.length === 0) {
      return `${title}: empty. Use !ships add <name>${profile?.callsign ? ` · callsign ${profile.callsign}` : ""}.`;
    }
    const total = ships.reduce((n, s) => n + s.qty, 0);
    const lines = ships.map((s) => {
      const warn = s.catalogMatched ? "" : " ⚠";
      return `• ${s.shipName} ×${s.qty}${warn}`;
    });
    const cs = profile?.callsign ? ` (${profile.callsign})` : "";
    return `${title}${cs} — ${total} hull(s):\n${lines.join("\n")}`;
  }

  private claimCallsign(invokerUid: string, code: string, _clients: HangarChannelClient[]): string {
    const cs = code.trim().toUpperCase();
    const fromKey = callsignOwnerKey(cs);
    const from = this.deps.store.getProfile(fromKey) ?? this.deps.store.getProfileByCallsign(cs);
    if (!from) {
      // Create empty callsign link
      const self = this.deps.store.ensureUidProfile(invokerUid);
      this.deps.store.upsertProfile({
        ownerKey: self.ownerKey,
        uid: invokerUid,
        callsign: cs,
      });
      return `No hangar under **${cs}** yet — callsign linked to you. Add ships with !ships add.`;
    }
    if (from.uid && from.uid !== invokerUid) {
      return `Callsign **${cs}** is already linked to another member. Ask a Colonel to reassign.`;
    }
    const self = this.deps.store.ensureUidProfile(invokerUid);
    const moved = this.deps.store.rekeyOwner(from.ownerKey, self.ownerKey);
    this.deps.store.upsertProfile({
      ownerKey: self.ownerKey,
      uid: invokerUid,
      callsign: cs,
    });
    void this.syncMemPalaceHangar(self.ownerKey);
    return moved > 0
      ? `Claimed **${cs}** — moved ${moved} hull type(s) into your hangar.`
      : `Linked **${cs}** to your hangar.`;
  }

  private resolveOwner(
    token: string,
    clients: HangarChannelClient[],
  ): { ownerKey: string; label: string } | null {
    const t = token.trim();
    if (!t) return null;

    // uid: or raw long uid
    if (t.startsWith("uid:")) {
      const uid = t.slice(4);
      const p = this.deps.store.ensureUidProfile(uid);
      return { ownerKey: p.ownerKey, label: p.displayName ?? uid.slice(0, 8) };
    }

    // Callsign code (2–6 alnum)
    if (/^[A-Za-z][A-Za-z0-9]{1,5}$/.test(t) && t.length <= 6) {
      const cs = t.toUpperCase();
      const byCs = this.deps.store.getProfileByCallsign(cs);
      if (byCs) return { ownerKey: byCs.ownerKey, label: formatOwnerLabel(byCs) };
      // Also try channel nick exact later
    }

    // Channel nickname match
    const nick = t.toLowerCase();
    const client = clients.find((c) => (c.nickname ?? "").toLowerCase() === nick);
    if (client?.uid) {
      const p = this.deps.store.ensureUidProfile(client.uid, client.nickname);
      return { ownerKey: p.ownerKey, label: client.nickname ?? client.uid.slice(0, 8) };
    }
    const fuzzyClient = clients.find((c) => (c.nickname ?? "").toLowerCase().includes(nick));
    if (fuzzyClient?.uid) {
      const p = this.deps.store.ensureUidProfile(fuzzyClient.uid, fuzzyClient.nickname);
      return { ownerKey: p.ownerKey, label: fuzzyClient.nickname ?? p.ownerKey };
    }

    // Callsign hangar even if not 2-6 (already tried short codes)
    const byCs = this.deps.store.getProfileByCallsign(t);
    if (byCs) return { ownerKey: byCs.ownerKey, label: formatOwnerLabel(byCs) };

    // Profile display name
    for (const p of this.deps.store.listProfiles()) {
      if (p.displayName && p.displayName.toLowerCase() === nick) {
        return { ownerKey: p.ownerKey, label: formatOwnerLabel(p) };
      }
    }

    // Create callsign bucket for org edits
    if (/^[A-Za-z][A-Za-z0-9]{1,5}$/.test(t)) {
      const p = this.deps.store.ensureCallsignProfile(t);
      return { ownerKey: p.ownerKey, label: formatOwnerLabel(p) };
    }

    return null;
  }

  private async resolveShipName(
    raw: string,
  ): Promise<{ name: string; shipId: string; catalogMatched: boolean }> {
    const q = raw.trim();
    const catalog = await Promise.resolve(this.deps.catalogShipNames?.() ?? []);
    const known = [...catalog, ...this.deps.store.knownShipNames()];
    const unique = [...new Set(known.filter(Boolean))];
    const best = fuzzyBestMatch(
      q,
      unique.map((n) => ({ name: n })),
      (s) => s.name,
      { minScore: 50 },
    );
    if (best) {
      return {
        name: best.name,
        shipId: shipIdFromName(best.name),
        catalogMatched: catalog.some((c) => c.toLowerCase() === best.name.toLowerCase()),
      };
    }
    // Store free-text with warning
    const name = q.replace(/\s+/g, " ").slice(0, 200);
    return { name, shipId: shipIdFromName(name), catalogMatched: false };
  }

  private importShipList(): string {
    const md = this.deps.readShipList?.();
    if (!md) return "Ship_List.md not found under doctrine.";
    const entries = parseShipListMarkdown(md);
    if (entries.length === 0) return "Ship_List.md had no parseable hangar lines.";

    // Replace callsign-bucket hangars so re-import is idempotent (no doubled qty).
    // Does not clear claimed uid: hangars.
    const codes = new Set(entries.map((e) => e.callsign.toUpperCase()));
    for (const cs of codes) {
      const key = callsignOwnerKey(cs);
      this.deps.store.clearShips(key);
      this.deps.store.ensureCallsignProfile(cs);
    }

    let ships = 0;
    let hulls = 0;
    for (const e of entries) {
      const profile = this.deps.store.ensureCallsignProfile(e.callsign);
      this.deps.store.addShip({
        ownerKey: profile.ownerKey,
        shipId: shipIdFromName(e.shipName),
        shipName: e.shipName,
        qty: e.qty,
        notes: e.notes,
        catalogMatched: false,
      });
      ships++;
      hulls += e.qty;
    }
    return (
      `Imported **${ships}** line(s) · **${hulls}** hulls · **${codes.size}** callsigns from Ship_List.md. ` +
      `Members: !ships claim <CODE>. Re-import replaces callsign buckets only.`
    );
  }

  private exportShipList(): string {
    if (!this.deps.writeShipList) return "Doctrine write path not configured.";
    const rows: ShipListExportRow[] = [];
    for (const s of this.deps.store.allShipsWithProfiles()) {
      const cs =
        s.profileCallsign ||
        (s.ownerKey.startsWith("cs:")
          ? s.ownerKey.slice(3)
          : s.ownerKey.replace(/^uid:/, "").slice(0, 6));
      rows.push({
        callsign: cs,
        displayName: s.profileDisplay,
        shipName: s.shipName,
        qty: s.qty,
        notes: s.notes,
      });
    }
    if (rows.length === 0) return "No hangar data to export.";
    const md = generateShipListMarkdown(rows);
    this.deps.writeShipList(md);
    return `Wrote Ship_List.md (${rows.length} hull lines). Run **!reindex** so RAG picks up secret fleet list.`;
  }

  private maybeExportHint(): void {
    /* reserved for auto-export toggle */
  }

  private async syncMemPalaceHangar(ownerKey: string): Promise<void> {
    if (!this.deps.mempalaceEnabled?.() || !this.deps.mempalace) return;
    const profile = this.deps.store.getProfile(ownerKey);
    const uid = profile?.uid;
    if (!uid) return; // callsign-only buckets: no private MemPalace room
    const ships = this.deps.store.listShips(ownerKey);
    const fact =
      ships.length === 0
        ? "hangar: (empty)"
        : `hangar: ${ships.map((s) => (s.qty > 1 ? `${s.shipName}×${s.qty}` : s.shipName)).join(", ")}`;
    try {
      // Best-effort: remember new hangar line (duplicates ok / bridge dedupes).
      await this.deps.mempalace.remember(uid, fact);
    } catch (err) {
      this.deps.logger?.warn({ err, ownerKey }, "hangar MemPalace sync failed");
    }
  }
}

function formatOwnerLabel(p: {
  callsign?: string | null;
  displayName?: string | null;
  uid?: string | null;
  ownerKey?: string;
}): string {
  if (p.callsign && p.displayName) return `${p.callsign} (${p.displayName})`;
  if (p.callsign) return p.callsign;
  if (p.displayName) return p.displayName;
  if (p.uid) return p.uid.slice(0, 10);
  return p.ownerKey ?? "?";
}

function splitArgs(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}

/** Parse "Prospector x2, Vulture, MSR ×3" */
export function parseShipSpecs(rest: string): Array<{ name: string; qty: number }> {
  if (!rest.trim()) return [];
  const chunks = rest
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  const out: Array<{ name: string; qty: number }> = [];
  for (const chunk of chunks) {
    let qty = 1;
    let name = chunk;
    const m1 = chunk.match(/^(\d+)\s*[x×]\s+(.+)$/i);
    const m2 = chunk.match(/^(.+?)\s+[x×]\s*(\d+)$/i);
    const m3 = chunk.match(/^(.+?)\s+x(\d+)$/i);
    if (m1) {
      qty = Math.max(1, parseInt(m1[1]!, 10) || 1);
      name = m1[2]!.trim();
    } else if (m2) {
      name = m2[1]!.trim();
      qty = Math.max(1, parseInt(m2[2]!, 10) || 1);
    } else if (m3) {
      name = m3[1]!.trim();
      qty = Math.max(1, parseInt(m3[2]!, 10) || 1);
    }
    if (name) out.push({ name, qty });
  }
  return out;
}

// re-export for tests
export { callsignOwnerKey, uidOwnerKey };
