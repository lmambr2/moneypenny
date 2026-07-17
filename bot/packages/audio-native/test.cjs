"use strict";
const { strict: assert } = require("node:assert");
const { test } = require("node:test");

let native;
try {
  native = require("./index.cjs");
} catch (e) {
  console.warn("skip native tests — addon not built:", e.message);
  process.exit(0);
}

const { NativeOpus, pcmRms, isSpeechFrame, nativeAudioBackend } = native;

test("backend id", () => {
  assert.equal(nativeAudioBackend(), "rust-libopus");
});

test("encode/decode silence mono 48k", () => {
  const codec = new NativeOpus(48000, 1);
  const pcm = Buffer.alloc(960 * 2, 0);
  const opus = codec.encode(pcm);
  assert.ok(opus.length > 0);
  const decoded = codec.decode(opus);
  assert.ok(decoded.length >= 960 * 2);
});

test("pcm_rms silence is low", () => {
  const pcm = Buffer.alloc(960 * 2, 0);
  assert.ok(pcmRms(pcm) < 1);
  assert.equal(isSpeechFrame(pcm, 500), false);
});
