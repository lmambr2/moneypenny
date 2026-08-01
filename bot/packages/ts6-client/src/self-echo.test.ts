/**
 * Self-echo guard: the client must never hand our own text messages back to
 * consumers.
 *
 * Live failure this locks: `!skip <query>` replied with text that LED with the
 * command prefix ("!skip / !next only advance the queue..."). The bot saw its
 * own message, re-parsed it as `skip` with args, produced the identical reply,
 * and flooded the channel until it was restarted.
 */
import { describe, expect, it, vi } from "vitest";
import { TS3Client } from "./client.js";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

type LibTextMessage = {
  invokerName: string;
  invokerID: number;
  invokerUID: string;
  invokerGroups?: string;
  message: string;
  targetMode: number;
};

/** Invoke the library-facing handler directly — it is wired inside connect(). */
function deliver(client: TS3Client, msg: LibTextMessage): void {
  (client as unknown as { onLibraryTextMessage(m: LibTextMessage): void }).onLibraryTextMessage(
    msg,
  );
}

function makeClient(ownClientId: number): TS3Client {
  const client = new TS3Client(
    { host: "localhost", port: 9987, queryPort: 10080, nickname: "Moneypenny" },
    logger,
  );
  (client as unknown as { clientId: number }).clientId = ownClientId;
  return client;
}

function libMsg(over: Partial<LibTextMessage> = {}): LibTextMessage {
  return {
    invokerName: over.invokerName ?? "Someone",
    invokerID: over.invokerID ?? 7,
    invokerUID: over.invokerUID ?? "uid-someone",
    message: over.message ?? "!skip some song",
    targetMode: over.targetMode ?? 2,
  };
}

describe("TS3Client self-echo guard", () => {
  it("does not emit a message sent by the bot itself", () => {
    const client = makeClient(42);
    const seen = vi.fn();
    client.on("textMessage", seen);

    deliver(client, libMsg({ invokerID: 42, message: "!skip / !next only advance the queue." }));

    expect(seen).not.toHaveBeenCalled();
  });

  it("still emits messages from other clients", () => {
    const client = makeClient(42);
    const seen = vi.fn();
    client.on("textMessage", seen);

    deliver(client, libMsg({ invokerID: 7, message: "!skip some song" }));

    expect(seen).toHaveBeenCalledOnce();
    expect(seen.mock.calls[0]![0]).toMatchObject({
      invokerId: "7",
      message: "!skip some song",
    });
  });

  it("emits normally before connect assigns a client id", () => {
    // clientId 0 = not connected yet; no id to compare against, so fail open
    // rather than swallowing real traffic.
    const client = makeClient(0);
    const seen = vi.fn();
    client.on("textMessage", seen);

    deliver(client, libMsg({ invokerID: 7 }));

    expect(seen).toHaveBeenCalledOnce();
  });

  it("breaks the loop: a self-sent reply that parses as a command is dropped", () => {
    const client = makeClient(42);
    const routed: string[] = [];
    client.on("textMessage", (m: { message: string }) => routed.push(m.message));

    // Human asks; bot answers with prefix-leading text; that echo comes back.
    deliver(client, libMsg({ invokerID: 7, message: "!skip some song" }));
    deliver(client, libMsg({ invokerID: 42, message: "!skip / !next only advance the queue." }));
    deliver(client, libMsg({ invokerID: 42, message: "!skip / !next only advance the queue." }));

    expect(routed).toEqual(["!skip some song"]);
  });

  it("drops the usage poison even when invoker id is wrong (not our clid)", () => {
    // Live failure: invokerID on self-echo sometimes does not match clientId,
    // so clid-only filtering lets the tip re-enter and flood.
    const client = makeClient(42);
    const routed: string[] = [];
    client.on("textMessage", (m: { message: string }) => routed.push(m.message));

    deliver(
      client,
      libMsg({
        invokerID: 99, // not us
        message:
          "!skip / !next only advance the queue. To start a title or URL now: !jump x (or !go).",
      }),
    );

    expect(routed).toEqual([]);
  });
});
