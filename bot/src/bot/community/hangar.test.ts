import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { UserShipsStore } from "../../data/user-ships.js";
import { HangarService, parseShipSpecs } from "./hangar.js";

describe("parseShipSpecs", () => {
  it("parses qty suffixes and lists", () => {
    expect(parseShipSpecs("Prospector x2, Vulture")).toEqual([
      { name: "Prospector", qty: 2 },
      { name: "Vulture", qty: 1 },
    ]);
    expect(parseShipSpecs("3× MSR")).toEqual([{ name: "MSR", qty: 3 }]);
  });
});

describe("HangarService", () => {
  function svc(opts?: { org?: boolean; shipList?: string }) {
    const store = new UserShipsStore(new Database(":memory:"));
    let shipList = opts?.shipList ?? null;
    const service = new HangarService({
      store,
      catalogShipNames: () => ["Prospector", "Vulture", "Carrack", "Polaris"],
      readShipList: () => shipList,
      writeShipList: (md) => {
        shipList = md;
      },
    });
    const canRun = (t: string) => (opts?.org ? true : t !== "ships.org");
    return { service, store, canRun, getList: () => shipList };
  }

  it("members can add and list with catalog match", async () => {
    const { service, canRun } = svc();
    const add = await service.handle("add Prospector x2", "uid-1", canRun, []);
    expect(add).toMatch(/Prospector/);
    const list = await service.handle("list", "uid-1", canRun, []);
    expect(list).toMatch(/×2/);
  });

  it("stores unknown names with warning", async () => {
    const { service, canRun } = svc();
    const add = await service.handle("add My Weird Hull", "uid-1", canRun, []);
    expect(add).toMatch(/warning|not in catalog/i);
  });

  it("denies org without ships.org", async () => {
    const { service, canRun } = svc({ org: false });
    const out = await service.handle("org who Carrack", "uid-1", canRun, []);
    expect(out).toMatch(/Colonel|Chairman|ships\.org/i);
  });

  it("colonel can org who", async () => {
    const { service, canRun } = svc({ org: true });
    await service.handle("add Carrack", "uid-a", canRun, []);
    // different member
    await service.handle("add Carrack", "uid-b", canRun, []);
    const who = await service.handle("org who Carrack", "uid-colonel", canRun, []);
    expect(who).toMatch(/Carrack/);
  });

  it("imports Ship_List.md", async () => {
    const md = `
### Combat
- **(GCV)** Polaris - LTI
- **(CHIP)** 2× Perseus
`;
    const { service, canRun, store } = svc({ org: true, shipList: md });
    const out = await service.handle("import", "uid-c", canRun, []);
    expect(out).toMatch(/Imported/);
    expect(store.listShips("cs:GCV").some((s) => s.shipName.includes("Polaris"))).toBe(true);
  });

  it("exports Ship_List.md", async () => {
    const { service, canRun, getList } = svc({ org: true });
    await service.handle("add Polaris", "uid-1", canRun, []);
    const out = await service.handle("export", "uid-c", canRun, []);
    expect(out).toMatch(/Wrote Ship_List/);
    expect(getList()).toMatch(/classification: secret/);
    expect(getList()).toMatch(/Polaris/);
  });
});
