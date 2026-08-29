import Database from "better-sqlite3";
import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuditStore } from "../../data/audit.js";
import { type BotDatabase, createDatabase } from "../../data/database.js";
import { createSessionStore } from "../../data/sessions.js";
import { createUserStore } from "../../data/users.js";
import {
  type IngestStore,
  initIngestStore,
  parseTerminalSnapshot,
  setIngestStoreForTests,
} from "../../economy/ingest.js";
import {
  type ScCraftBlueprint,
  type ScCraftClient,
  setScCraftClientForTests,
} from "../../economy/sc-craft.js";
import { setUexClientForTests, UexClient } from "../../economy/uex.js";
import {
  initWorkOrderStore,
  setWorkOrderStoreForTests,
  type WorkOrderStore,
} from "../../economy/work-orders.js";
import { SESSION_COOKIE_NAME } from "../auth/validateSession.js";
import { createRequireAuth } from "../middleware/requireAuth.js";
import { createEconomyRouter } from "./economy.js";

function mockUex(): UexClient {
  return {
    isEnabled: () => true,
    clearCache: () => {},
    getCommodities: async () => [
      { id: 2, name: "Bexalite", code: "BEXA", is_raw: 0, price_sell: 28000, price_buy: 20000 },
      { id: 1, name: "Agricium", code: "AGRI", is_raw: 0, price_sell: 9000, price_buy: 5000 },
      { id: 3, name: "Bexalite (Raw)", code: "BEXR", is_raw: 1, price_sell: 1000 },
    ],
    getTerminalPrices: async () => [],
    buildSupplyHint: () => ({
      supplyPct: null,
      sellTerminals: [],
      buyTerminals: [],
      sampleSize: 0,
    }),
    lookupPrice: async (q: string) => {
      if (!/bex/i.test(q)) return null;
      return {
        commodity: {
          id: 2,
          name: "Bexalite",
          code: "BEXA",
          price_sell: 28000,
          price_buy: 20000,
        },
        sell: 28000,
        buy: 20000,
        matches: [],
        fetchedAt: Date.now(),
        attribution: "test",
        supply: null,
      };
    },
  } as unknown as UexClient;
}

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
  let ingest: IngestStore;
  let sqlite: Database.Database;
  let audit: ReturnType<typeof createAuditStore>;

  beforeEach(async () => {
    botDb = createDatabase(":memory:");
    sqlite = new Database(":memory:");
    store = initWorkOrderStore(sqlite);
    ingest = initIngestStore(sqlite);
    audit = createAuditStore(botDb.db);
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
    setUexClientForTests(mockUex());

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/api", createRequireAuth(sessions));
    app.use(
      "/api/economy",
      createEconomyRouter({
        store,
        ingest,
        scCraft: mockCraft(bp),
        uex: mockUex(),
        audit,
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
    setIngestStoreForTests(null);
    setScCraftClientForTests(null);
    setUexClientForTests(null);
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

  it("lists UEX commodities for prices dropdown (sorted by name)", async () => {
    const res = await request(app).get("/api/economy/commodities").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.commodities.map((c: { name: string }) => c.name)).toEqual([
      "Agricium",
      "Bexalite",
      "Bexalite (Raw)",
    ]);
    expect(res.body.commodities[0].code).toBe("AGRI");
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

  it("records audit entries for clear-all and cache refresh", async () => {
    await request(app)
      .post("/api/economy/workorders")
      .set("Cookie", cookie)
      .send({ item: "P4-AR", qty: 1 });
    await request(app).delete("/api/economy/workorders").set("Cookie", cookie);
    await request(app).post("/api/economy/cache/refresh").set("Cookie", cookie);

    const entries = audit.list(20, 0);
    const clear = entries.find((e) => e.action === "economy.workorders_clear");
    expect(clear).toBeDefined();
    expect(clear?.actorUsername).toBe("alice");
    expect(clear?.targetUsername).toBe("1 orders");
    expect(entries.some((e) => e.action === "economy.cache_refresh")).toBe(true);
  });

  const snapBody = {
    source: "datarunner",
    game_version: "4.10.0",
    environment: "LIVE",
    id_terminal: 89,
    terminal_name: "Area 18 TDD",
    type: "commodity",
    prices: [
      {
        id_commodity: 1,
        name: "Agricium",
        price_buy: 4000,
        price_sell: 12100,
        scu_sell: 40,
        status_sell: 3,
      },
    ],
    captured_at: Date.now() + 120_000,
  };

  it("ingests a terminal snapshot for admin and lists it", async () => {
    const created = await request(app)
      .post("/api/economy/ingest/terminal-snapshot")
      .set("Cookie", cookie)
      .send(snapBody);
    expect(created.status).toBe(201);
    expect(created.body.snapshot.id_terminal).toBe(89);
    expect(created.body.snapshot.status).toBe("accepted");

    const list = await request(app).get("/api/economy/ingest/snapshots").set("Cookie", cookie);
    expect(list.status).toBe(200);
    expect(list.body.count).toBe(1);
  });

  it("rejects ingest from a member session", async () => {
    const users = createUserStore(botDb.db);
    const sessions = createSessionStore(botDb.db);
    const bob = await users.createUser("bob-ingest", "pw-bobbbbb", "member");
    const bobCookie = `${SESSION_COOKIE_NAME}=${sessions.createSession(bob.id).token}`;
    const denied = await request(app)
      .post("/api/economy/ingest/terminal-snapshot")
      .set("Cookie", bobCookie)
      .send(snapBody);
    expect(denied.status).toBe(403);
  });

  it("rejects unauthenticated ingest", async () => {
    const res = await request(app).post("/api/economy/ingest/terminal-snapshot").send(snapBody);
    expect(res.status).toBe(401);
  });

  it("validates ingest bodies", async () => {
    const res = await request(app)
      .post("/api/economy/ingest/terminal-snapshot")
      .set("Cookie", cookie)
      .send({ type: "commodity" });
    expect(res.status).toBe(400);
  });

  it("accepts ingest with ECONOMY_INGEST_TOKEN bearer", async () => {
    const prev = process.env.ECONOMY_INGEST_TOKEN;
    process.env.ECONOMY_INGEST_TOKEN = "test-ingest-token-please";
    try {
      const res = await request(app)
        .post("/api/economy/ingest/terminal-snapshot")
        .set("Authorization", "Bearer test-ingest-token-please")
        .send(snapBody);
      expect(res.status).toBe(201);
      expect(res.body.snapshot.created_by).toBe("datarunner");
    } finally {
      if (prev === undefined) delete process.env.ECONOMY_INGEST_TOKEN;
      else process.env.ECONOMY_INGEST_TOKEN = prev;
    }
  });

  it("GET /prices uses a fresher local snapshot over UEX", async () => {
    ingest.add(parseTerminalSnapshot(snapBody));
    const uex = new UexClient({
      enabled: true,
      fetchCommodities: async () => [
        { id: 1, name: "Agricium", code: "AGRI", is_raw: 0, price_sell: 9000, price_buy: 5000 },
      ],
      fetchTerminalPrices: async () => [],
    });
    setUexClientForTests(uex);
    const priced = express();
    priced.use(express.json());
    priced.use(cookieParser());
    const sessions = createSessionStore(botDb.db);
    priced.use("/api", createRequireAuth(sessions));
    priced.use("/api/economy", createEconomyRouter({ ingest, uex, audit }));
    const res = await request(priced).get("/api/economy/prices?q=Agricium").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("local");
    expect(res.body.sell).toBe(12100);
  });
});
