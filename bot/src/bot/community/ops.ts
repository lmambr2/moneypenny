/**
 * Org/ops command surface (feature-roadmap G1).
 * Aggregates radio-adjacent status + external plugins. Never blocks music —
 * all external calls are fail-open via ExternalStatusRegistry.
 */

import type { ExternalStatusRegistry } from "../../tools/external-status.js";

export interface OpsServiceDeps {
  getRadioStatus?: () => string | Promise<string>;
  getNowPlaying?: () => string | null | Promise<string | null>;
  getOrgBrief?: () => string | Promise<string>;
  statusRegistry: ExternalStatusRegistry;
  /** Rights check; if omitted, allow. */
  canRun?: (command: string) => boolean;
}

export class OpsService {
  constructor(private deps: OpsServiceDeps) {}

  static readonly USAGE =
    "Usage: !ops [status|brief|sc|host|list] — org brief + external status (fail-open).";

  async handle(args: string, canRun?: (command: string) => boolean): Promise<string> {
    const gate = canRun ?? this.deps.canRun;
    if (gate && !gate("ops") && !gate("radio.ops") && !gate("analyst")) {
      return "You don't have permission for !ops (needs ops, radio.ops, or analyst).";
    }

    const sub = args.trim().toLowerCase().split(/\s+/)[0] || "status";

    switch (sub) {
      case "list":
        return this.listSources();
      case "sc":
      case "star-citizen":
        return this.oneStatus("sc-org");
      case "host":
        return this.oneStatus("host");
      case "brief":
        return this.brief();
      case "status":
      case "":
        return this.fullStatus();
      default:
        // Treat unknown token as a status plugin id
        if (this.deps.statusRegistry.list().some((p) => p.id === sub)) {
          return this.oneStatus(sub);
        }
        return OpsService.USAGE;
    }
  }

  private listSources(): string {
    const plugins = this.deps.statusRegistry.list();
    if (plugins.length === 0) return "No external status plugins registered.";
    return `Status sources: ${plugins.map((p) => `${p.id} (${p.label})`).join(", ")}`;
  }

  private async oneStatus(id: string): Promise<string> {
    const r = await this.deps.statusRegistry.get(id);
    const flag = r.ok ? "✓" : "○";
    return `${flag} ${r.label}: ${r.text}`;
  }

  private async brief(): Promise<string> {
    const parts: string[] = [];
    if (this.deps.getOrgBrief) {
      try {
        const b = await this.deps.getOrgBrief();
        if (b.trim()) parts.push(b.trim());
      } catch {
        parts.push("Org brief unavailable.");
      }
    }
    const sc = await this.deps.statusRegistry.get("sc-org");
    parts.push(`${sc.ok ? "✓" : "○"} ${sc.label}: ${sc.text}`);
    return parts.join("\n") || "No brief available.";
  }

  private async fullStatus(): Promise<string> {
    const lines: string[] = ["📋 Ops status"];
    if (this.deps.getNowPlaying) {
      try {
        const np = await this.deps.getNowPlaying();
        lines.push(np ? `Now: ${np}` : "Now: (nothing playing)");
      } catch {
        lines.push("Now: (unavailable)");
      }
    }
    if (this.deps.getRadioStatus) {
      try {
        lines.push(await this.deps.getRadioStatus());
      } catch {
        lines.push("Radio: (unavailable)");
      }
    }
    if (this.deps.getOrgBrief) {
      try {
        const b = await this.deps.getOrgBrief();
        if (b.trim()) lines.push(b.trim());
      } catch {
        /* ignore */
      }
    }
    const all = await this.deps.statusRegistry.getAll();
    for (const r of all) {
      lines.push(`${r.ok ? "✓" : "○"} ${r.label}: ${r.text}`);
    }
    return lines.join("\n");
  }
}
