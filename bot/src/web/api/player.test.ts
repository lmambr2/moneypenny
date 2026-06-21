import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { createDatabase, type BotDatabase } from "../../data/database.js";
import { createUserStore } from "../../data/users.js";
import { createSessionStore } from "../../data/sessions.js";
import { createRequireAuth } from "../middleware/requireAuth.js";
import { createPlayerRouter } from "./player.js";
import { SESSION_COOKIE_NAME } from "../auth/validateSession.js";
import { RightsEngine, defaultRightsConfig } from "../../rights/index.js";

describe("player router", () => {
  let botDb: BotDatabase;
  let adminCookie: string;
  let memberCookie: string;
  let app: express.Express;
  let routedCalls: string[];
  let users: ReturnType<typeof createUserStore>;
  let sessions: ReturnType<typeof createSessionStore>;

  beforeEach(async () => {
    botDb = createDatabase(":memory:");
    users = createUserStore(botDb.db);
    sessions = createSessionStore(botDb.db);
    const admin = await users.createUser("admin", "pw-admin1", "admin");
    const member = await users.createUser("bob", "pw-bob1234", "member");
    adminCookie = `${SESSION_COOKIE_NAME}=${sessions.createSession(admin.id).token}`;
    memberCookie = `${SESSION_COOKIE_NAME}=${sessions.createSession(member.id).token}`;

    routedCalls = [];

    const rights = defaultRightsConfig([107]);
    rights.defaultAllow = ["help"];
    rights.rules = [
      ...(rights.rules ?? []),
      { name: "web-admins-play", match: { serverGroups: ["107"] }, allow: ["play"] },
      { name: "field-grade-vol", match: { serverGroups: ["105"] }, allow: ["vol"] },
    ];
    const engine = new RightsEngine(rights);

    const resolveSubjectForUser = (user: { id: string; username: string; role: string }) => {
      if (user.role === "admin") {
        return { uid: `web:${user.id}`, serverGroups: ["107"], nickname: user.username };
      }
      if (user.username.toLowerCase() === "alice") {
        return { uid: "alice-uid", serverGroups: ["105"], nickname: "Alice Field" };
      }
      return { uid: `web:${user.id}`, serverGroups: [], nickname: user.username };
    };

    const bot = {
      id: "b1",
      isConnected: () => true,
      canWebUserRunCommand: async (user: { id: string; username: string; role: string }, cmd: string) =>
        engine.can(resolveSubjectForUser(user), cmd),
      executeRoutedCommand: async (cmd: { name: string }, opts?: { webUser?: { id: string; username: string; role: string } }) => {
        const user = opts?.webUser;
        if (user) {
          const subject = resolveSubjectForUser(user);
          if (!engine.can(subject, cmd.name)) {
            return { message: `You don't have permission to use '${cmd.name}'.`, denied: true };
          }
        }
        routedCalls.push(cmd.name);
        return { message: `executed:${cmd.name}`, denied: false };
      },
      getPlayer: () => ({ getElapsed: () => 0, stop: () => {}, resetFailures: () => {}, seek: () => {}, getState: () => "idle" }),
      getQueue: () => [],
      getQueueManager: () => ({
        size: () => 0,
        clear: () => {},
        add: () => {},
        playAt: () => null,
        play: () => null,
        current: () => null,
        getCurrentIndex: () => -1,
        getMode: () => "seq",
        addNext: () => {},
      }),
      resolveAndPlay: async () => true,
      getProviderFor: () => ({ getPlaylistSongs: async () => [], getAlbumSongs: async () => [], getSongDetail: async () => null, platform: "youtube" as const }),
      getProfileManager: () => ({ getConfig: () => ({}), updateConfig: () => {} }),
      getStatus: () => ({ id: "b1" }),
    };

    const botManager = {
      getBot: (id: string) => (id === "b1" ? bot : undefined),
    };

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/api", createRequireAuth(sessions));
    app.use("/api/player", createPlayerRouter(botManager as any, console as any));
  });

  afterEach(() => {
    botDb.close();
  });

  it("routes /play through executeRoutedCommand", async () => {
    const res = await request(app)
      .post("/api/player/b1/play")
      .set("Cookie", adminCookie)
      .send({ query: "test song", platform: "youtube" });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("executed:play");
    expect(routedCalls).toEqual(["play"]);
  });

  it("returns 403 when rank gating denies play for a member", async () => {
    const res = await request(app)
      .post("/api/player/b1/play")
      .set("Cookie", memberCookie)
      .send({ query: "test song" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PERMISSION_DENIED");
  });

  it("allows admin web users through rank gating when admin TS groups are configured", async () => {
    const res = await request(app)
      .post("/api/player/b1/play")
      .set("Cookie", adminCookie)
      .send({ query: "test song" });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("executed:play");
  });

  it("requires query on /add", async () => {
    const res = await request(app)
      .post("/api/player/b1/add")
      .set("Cookie", adminCookie)
      .send({ platform: "youtube" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("allows volume for a web member matched to a field-grade TS rank", async () => {
    const alice = await users.createUser("alice", "pw-alice1234", "member");
    const aliceCookie = `${SESSION_COOKIE_NAME}=${sessions.createSession(alice.id).token}`;
    const res = await request(app)
      .post("/api/player/b1/volume")
      .set("Cookie", aliceCookie)
      .send({ volume: 42 });
    expect(res.status).toBe(200);
    expect(routedCalls).toContain("vol");
  });

  it("rejects invalid platform on /play-song", async () => {
    const res = await request(app)
      .post("/api/player/b1/play-song")
      .set("Cookie", adminCookie)
      .send({ song: { id: "x", platform: "netease", name: "n", artist: "a" } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });
});