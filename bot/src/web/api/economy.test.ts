import Database from "better-sqlite3";
import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BotDatabase, createDatabase } from "../../data/database.js";
import { createSessionStore } from "../../data/sessions.js";
import { createUserStore } from "../../data/users.js";
import {
  type ScCraftBlueprint,
  type ScCraftClient,
  setScCraftClientForTests,
} from "../../economy/sc-craft.js";
import {
  initWorkOrderStore,
  setWorkOrderStoreForTests,
  type WorkOrderStore,
} from "../../economy/work-orders.js";
import { SESSION_COOKIE_NAME } from "../auth/validateSession.js";
import { createRequireAuth } from "../middleware/requireAuth.js";
import { createEconomyRouter } from "./economy.js";

function mockCraft(bp: ScCraftBlueprint): ScCraftClient {
  return {
    isEnabled: () => true,
    clearCache: () => {},
    search: async () => ({
      items: [bp],
      total: 1,
      fetchedAt: Date.now(),
      attribution: "test",
    }),
    getById: async () => bp,
    resolveBlueprint: async () => bp,
  } as unknown as ScCraftClient;
}

describe("economy router", () => {
  let botDb: BotDatabase;
  let app: express.Express;
  let cookie: string;
  let store: WorkOrderStore;
  let sqlite: Database.Database;

  beforeEach(async () => {
    botDb = createDatabase(":memory:");
    sqlite = new Database(":memory:");
    store = initWorkOrderStore(sqlite);
    const users = createUserStore(botDb.db);
    const sessions = createSessionStore(botDb.db);
    const alice = await users.createUser("alice", "pw-alice", "admin");
    cookie = `${SESSION_COOKIE_NAME}=${sessions.createSession(alice.id).token}`;

    const bp: ScCraftBlueprint = {
      id: 42,
      blueprint_id: "p4-ar",
      name: "P4-AR",
      category: "Weapons",
      ingredients: [
        { name: "Titanium", quantity_scu: 4 },
        { name: "Quantainium", quantity_scu: 1 },
      ],
    };
    setScCraftClientForTests(mockCraft(bp));

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/api", createRequireAuth(sessions));
    app.use(
      "/api/economy",
      createEconomyRouter({
        store,
        scCraft: mockCraft(bp),
        refresh: async () => ({
          at: Date.now(),
          ok: true,
          results: [{ source: "test", key: "warm", ok: true, detail: "ok" }],
        }),
      }),
    );
  });

  afterEach(() => {
    setWorkOrderStoreForTests(null);
    setScCraftClientForTests(null);
    sqlite.close();
    botDb.close();
  });

  it("requires auth", async () => {
    const res = await request(app).get("/api/economy/overview");
    expect(res.status).toBe(401);
  });

  it("returns overview + ores + methods", async () => {
    const ov = await request(app).get("/api/economy/overview").set("Cookie", cookie);
    expect(ov.status).toBe(200);
    expect(ov.body.oreCount).toBeGreaterThan(5);
    expect(ov.body.clients.scCraft).toBe(true);

    const ores = await request(app).get("/api/economy/ores?q=quant").set("Cookie", cookie);
    expect(ores.status).toBe(200);
    expect(ores.body.ores.some((o: { id: string }) => o.id.includes("quant"))).toBe(true);

    const methods = await request(app).get("/api/economy/methods").set("Cookie", cookie);
    expect(methods.body.methods.some((m: { id: string }) => m.id === "dinyx")).toBe(true);
  });

  it("computes mine and refine orders", async () => {
    const mine = await request(app)
      .get("/api/economy/mine?ore=quantainium&scu=16")
      .set("Cookie", cookie);
    expect(mine.status).toBe(200);
    expect(mine.body.targetScu).toBe(16);
    expect(mine.body.ore.name).toMatch(/Quantainium/i);

    const refine = await request(app)
      .get("/api/economy/refine?ore=quantainium&scu=32&method=dinyx")
      .set("Cookie", cookie);
    expect(refine.status).toBe(200);
    expect(refine.body.inputScu).toBe(32);
    expect(refine.body.outputScu).toBeCloseTo(14.4, 1);
  });

  it("resolves craft BOM and manages work orders", async () => {
    const craft = await request(app).get("/api/economy/craft?q=P4-AR&qty=2").set("Cookie", cookie);
    expect(craft.status).toBe(200);
    expect(craft.body.qty).toBe(2);
    expect(craft.body.bom.length).toBe(2);
    expect(craft.body.bom[0].amount).toBe(8); // 4*2

    const created = await request(app)
      .post("/api/economy/workorders")
      .set("Cookie", cookie)
      .send({ item: "P4-AR", qty: 3 });
    expect(created.status).toBe(201);
    expect(created.body.order.itemName).toBe("P4-AR");
    expect(created.body.order.qty).toBe(3);
    const id = created.body.order.id as number;

    const list = await request(app).get("/api/economy/workorders").set("Cookie", cookie);
    expect(list.status).toBe(200);
    expect(list.body.open).toBe(1);
    expect(list.body.materials.length).toBeGreaterThan(0);

    const done = await request(app).delete(`/api/economy/workorders/${id}`).set("Cookie", cookie);
    expect(done.status).toBe(200);

    await request(app)
      .post("/api/economy/workorders")
      .set("Cookie", cookie)
      .send({ item: "P4-AR", qty: 1 });
    const cleared = await request(app).delete("/api/economy/workorders").set("Cookie", cookie);
    expect(cleared.body.cleared).toBe(1);
  });

  it("returns cache status without absolute path; admin can refresh", async () => {
    const cache = await request(app).get("/api/economy/cache").set("Cookie", cookie);
    expect(cache.status).toBe(200);
    expect(cache.body).toHaveProperty("rootLabel");
    expect(cache.body.root).toBeUndefined();
    expect(String(cache.body.rootLabel)).not.toMatch(/^\/home\//);

    const refresh = await request(app).post("/api/economy/cache/refresh").set("Cookie", cookie);
    expect(refresh.status).toBe(200);
    expect(refresh.body.ok).toBe(true);
    expect(refresh.body.results[0].source).toBe("test");
  });

  it("restricts clear-all to admin", async () => {
    const users = createUserStore(botDb.db);
    const sessions = createSessionStore(botDb.db);
    const bob = await users.createUser("bob", "pw-bobbbbb", "member");
    const bobCookie = `${SESSION_COOKIE_NAME}=${sessions.createSession(bob.id).token}`;

    await request(app)
      .post("/api/economy/workorders")
      .set("Cookie", cookie)
      .send({ item: "P4-AR", qty: 1 });

    const denied = await request(app).delete("/api/economy/workorders").set("Cookie", bobCookie);
    expect(denied.status).toBe(403);

    const ok = await request(app).delete("/api/economy/workorders").set("Cookie", cookie);
    expect(ok.status).toBe(200);
    expect(ok.body.cleared).toBeGreaterThanOrEqual(1);
  });
});
