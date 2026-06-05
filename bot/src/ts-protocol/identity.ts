import nacl from "tweetnacl";
import crypto from "node:crypto";

export interface TS3Identity {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  uid: string; // base64-encoded SHA1 of public key
}

export function generateIdentity(): TS3Identity {
  const keypair = nacl.sign.keyPair();
  const uid = computeUid(keypair.publicKey);
  return {
    publicKey: keypair.publicKey,
    privateKey: keypair.secretKey,
    uid,
  };
}

export function computeUid(publicKey: Uint8Array): string {
  return crypto.createHash("sha1").update(publicKey).digest("base64");
}

export function exportIdentity(identity: TS3Identity): string {
  return JSON.stringify({
    publicKey: Buffer.from(identity.publicKey).toString("base64"),
    privateKey: Buffer.from(identity.privateKey).toString("base64"),
  });
}

export function importIdentity(data: string): TS3Identity {
  const parsed = JSON.parse(data) as { publicKey: string; privateKey: string };
  const publicKey = new Uint8Array(Buffer.from(parsed.publicKey, "base64"));
  const privateKey = new Uint8Array(Buffer.from(parsed.privateKey, "base64"));
  const uid = computeUid(publicKey);
  return { publicKey, privateKey, uid };
}
