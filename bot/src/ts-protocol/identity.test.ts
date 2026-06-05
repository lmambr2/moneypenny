import { describe, it, expect } from "vitest";
import { generateIdentity, exportIdentity, importIdentity } from "./identity.js";

describe("TS3 Identity", () => {
  it("generates a valid identity with keypair", () => {
    const identity = generateIdentity();
    expect(identity.publicKey).toBeInstanceOf(Uint8Array);
    expect(identity.privateKey).toBeInstanceOf(Uint8Array);
    expect(identity.publicKey.length).toBe(32);
    expect(identity.privateKey.length).toBe(64);
    expect(identity.uid).toBeTruthy();
    expect(typeof identity.uid).toBe("string");
  });

  it("exports and imports identity consistently", () => {
    const identity = generateIdentity();
    const exported = exportIdentity(identity);
    const imported = importIdentity(exported);
    expect(imported.uid).toBe(identity.uid);
    expect(imported.publicKey).toEqual(identity.publicKey);
  });

  it("generates unique identities each time", () => {
    const id1 = generateIdentity();
    const id2 = generateIdentity();
    expect(id1.uid).not.toBe(id2.uid);
  });
});
