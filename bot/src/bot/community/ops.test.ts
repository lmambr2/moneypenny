import { describe, expect, it } from "vitest";
import { ExternalStatusRegistry } from "../../tools/external-status.js";
import { OpsService } from "./ops.js";

describe("OpsService (G1)", () => {
  function harness() {
    const statusRegistry = new ExternalStatusRegistry({ cacheTtlMs: 0 });
    statusRegistry.register({
      id: "sc-org",
      label: "Star Citizen org status",
      fetch: async () => {
        throw new Error("offline");
      },
    });
    statusRegistry.register({
      id: "host",
      label: "Host health",
      fetch: async () => "host ok",
    });
    const ops = new OpsService({
      statusRegistry,
      getNowPlaying: async () => "Track A — Artist",
      getRadioStatus: async () => "Radio: on · profile lobby",
      getOrgBrief: async () => "Org: FC is Alice",
    });
    return { ops, statusRegistry };
  }

  it("status aggregates without throwing when SC is down", async () => {
    const { ops } = harness();
    const text = await ops.handle("status", () => true);
    expect(text).toMatch(/Track A/);
    expect(text).toMatch(/Radio: on/);
    expect(text).toMatch(/Alice/);
    expect(text).toMatch(/unavailable|offline/i);
    expect(text).toMatch(/host ok/);
  });

  it("denies without rights", async () => {
    const { ops } = harness();
    const text = await ops.handle("status", () => false);
    expect(text).toMatch(/permission/i);
  });

  it("sc subcommand fail-open", async () => {
    const { ops } = harness();
    const text = await ops.handle("sc", () => true);
    expect(text).toMatch(/unavailable/i);
  });

  it("list sources", async () => {
    const { ops } = harness();
    const text = await ops.handle("list", () => true);
    expect(text).toMatch(/sc-org/);
    expect(text).toMatch(/host/);
  });

  it("members/fleet fail-open when not configured (R5)", async () => {
    const { ops } = harness();
    expect(await ops.handle("members", () => true)).toMatch(/not configured/i);
    expect(await ops.handle("fleet", () => true)).toMatch(/not configured/i);
  });

  it("members/fleet return text from injectables", async () => {
    const statusRegistry = new ExternalStatusRegistry({ cacheTtlMs: 0 });
    const ops = new OpsService({
      statusRegistry,
      getScMembers: async () => "SC members (1 online / 2):\n● Alice",
      getScFleet: async () => "SC fleet: 1 vessel\n· Idris",
    });
    expect(await ops.handle("members", () => true)).toMatch(/Alice/);
    expect(await ops.handle("fleet", () => true)).toMatch(/Idris/);
  });
});
