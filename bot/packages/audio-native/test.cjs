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

const {
  NativeOpus,
  NativeVoiceFrame,
  pcmRms,
  pcmPeak,
  pcmScale,
  pcmMix,
  pcmApplyPlaybackGain,
  isSpeechFrame,
  nativeAudioBackend,
  normalizePcmForStt,
  splitOpusPacket,
} = native;

function s16(values) {
  const b = Buffer.alloc(values.length * 2);
  for (let i = 0; i < values.length; i++) b.writeInt16LE(values[i], i * 2);
  return b;
}

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

test("pcm peak / scale / mix", () => {
  const a = s16([1000, -2000, 32767]);
  assert.equal(pcmPeak(a), 32767);
  const scaled = pcmScale(a, 2);
  assert.equal(scaled.readInt16LE(0), 2000);
  assert.equal(scaled.readInt16LE(4), 32767); // clamped
  const mixed = pcmMix(s16([1000]), 1, s16([500]), 1);
  assert.equal(mixed.readInt16LE(0), 1500);
});

test("playback gain matches JS volume curve (slider * 0.2)", () => {
  const pcm = s16([10000]);
  const out = pcmApplyPlaybackGain(pcm, 30, false, 0, 0);
  assert.equal(out.readInt16LE(0), 600); // 10000 * 0.06
  const ducked = pcmApplyPlaybackGain(pcm, 30, true, 2, 0);
  assert.equal(ducked.readInt16LE(0), 40); // 10000 * 0.004
  const floored = pcmApplyPlaybackGain(pcm, 30, true, 2, 85);
  assert.equal(floored.readInt16LE(0), 1700); // floor beats duck
});

test("STT normalize skips DTX, boosts quiet speech, attenuates clip", () => {
  const dtx = s16([3, 3, 3, 3]);
  assert.equal(pcmPeak(normalizePcmForStt(dtx, 12000, 120, 80)), 3);
  const quiet = Buffer.alloc(200);
  for (let i = 0; i < 100; i++) quiet.writeInt16LE(200, i * 2);
  const boosted = normalizePcmForStt(quiet, 12000, 120, 80);
  assert.ok(pcmPeak(boosted) > 200);
  const hot = Buffer.alloc(200);
  for (let i = 0; i < 100; i++) hot.writeInt16LE(32767, i * 2);
  assert.equal(pcmPeak(normalizePcmForStt(hot, 12000, 120, 80)), Math.round(12000 * 0.65));
});

test("NativeVoiceFrame process is one-pass", () => {
  const pcm = Buffer.alloc(200);
  for (let i = 0; i < 100; i++) pcm.writeInt16LE(200, i * 2);
  const out = new NativeVoiceFrame().process(pcm);
  assert.equal(out.rawPeak, 200);
  assert.equal(out.speech, true);
  assert.equal(out.clipped, false);
  assert.ok(out.peak > 200);
  assert.ok(out.pcmForStt.length === pcm.length);
});

test("decodeVoice classifies empty / round-trip", () => {
  const codec = new NativeOpus(48000, 1);
  const empty = codec.decodeVoice(Buffer.alloc(0));
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, "empty");
  const pcm = Buffer.alloc(960 * 2, 0);
  const opus = codec.encode(pcm);
  const voice = codec.decodeVoice(opus);
  assert.equal(voice.ok, true);
  assert.ok(voice.pcm.length >= 960 * 2);
});

test("splitOpusPacket single frame", () => {
  const codec = new NativeOpus(48000, 1);
  const opus = codec.encode(Buffer.alloc(960 * 2, 0));
  const frames = splitOpusPacket(opus);
  assert.equal(frames.length, 1);
});
