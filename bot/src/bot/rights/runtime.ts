import type { BotConfig } from "../../data/config.js";
import type { Logger } from "../../logger.js";
import {
  defaultRightsConfig,
  type RightsConfig,
  RightsEngine,
  type Subject,
} from "../../rights/index.js";
import type { TS3Client } from "@moneypenny/ts6-client";
import { resolveSubject } from "./subject.js";

export interface RightsRuntimeDeps {
  config: BotConfig;
  logger: Logger;
  tsClient: TS3Client;
}

/** Rank-gating lifecycle and debug helpers (DESIGN §8). */
export class RightsRuntime {
  private engine: RightsEngine | null = null;

  constructor(private deps: RightsRuntimeDeps) {}

  getEngine(): RightsEngine | null {
    return this.engine;
  }

  initialize(): void {
    if (this.deps.config.rightsEnabled ?? true) {
      this.engine = new RightsEngine(
        this.deps.config.rights ?? defaultRightsConfig(this.deps.config.adminGroups),
      );
      this.deps.logger.info("Rank gating enabled");
    }
  }

  updateRights(enabled: boolean, rights?: RightsConfig): void {
    this.deps.config.rightsEnabled = enabled;
    this.deps.config.rights = rights;
    if (!enabled) {
      this.engine = null;
      return;
    }
    const cfg = rights ?? defaultRightsConfig(this.deps.config.adminGroups);
    if (this.engine) this.engine.reload(cfg);
    else this.engine = new RightsEngine(cfg);
  }

  async getEffectiveRights(opts?: { uid?: string; serverGroups?: string[] }): Promise<{
    subject: Subject;
    rightsEnabled: boolean;
    chat: string[];
    voice: string[];
  }> {
    let subject: Subject;
    if (opts?.serverGroups && opts.serverGroups.length > 0) {
      subject = {
        uid: opts.uid?.trim() || "debug-subject",
        serverGroups: opts.serverGroups.map(String),
      };
    } else if (opts?.uid?.trim()) {
      subject = await resolveSubject(opts.uid.trim(), this.deps.tsClient, this.deps.logger);
    } else {
      subject = { uid: "debug-public-sample", serverGroups: [] };
    }
    const engine = this.engine;
    if (!engine) return { subject, rightsEnabled: false, chat: ["*"], voice: ["*"] };
    return {
      subject,
      rightsEnabled: true,
      chat: Array.from(engine.computeAllowed(subject, "chat")).sort(),
      voice: Array.from(engine.computeAllowed(subject, "voice")).sort(),
    };
  }
}
