/** Opus DTX / comfort-noise frames from TeamSpeak are tiny and not decodable. */
export const OPUS_DTX_MAX_BYTES = 12;

/**
 * True when a failed decode payload is DTX-sized (TeamSpeak comfort noise).
 * Do not use before decode — valid encoded silence can also be ≤12 bytes.
 */
export function isDtxSizedPacket(packet: Buffer): boolean {
  return packet.length <= OPUS_DTX_MAX_BYTES;
}

function parseSize(data: Buffer, offset: number): { size: number; bytes: number } | null {
  if (offset >= data.length) return null;
  const b0 = data[offset]!;
  if (b0 < 252) return { size: b0, bytes: 1 };
  if (offset + 1 >= data.length) return null;
  return { size: 4 * data[offset + 1]! + b0, bytes: 2 };
}

/**
 * Split a TeamSpeak Opus voice payload into single-frame packets decodable by
 * the Opus decoder. Returns null when the TOC/layout is invalid.
 *
 * Ported from libopus `opus_packet_parse` (RFC 6716 §3).
 */
export function splitOpusPacket(packet: Buffer): Buffer[] | null {
  if (packet.length === 0) return null;

  const toc = packet[0]!;
  const mode = toc & 0x03;
  const sizes: number[] = [];
  let offset = 1;
  let len = packet.length - 1;
  let count: number;
  let cbr = false;

  switch (mode) {
    case 0:
      count = 1;
      sizes.push(len);
      break;
    case 1:
      count = 2;
      cbr = true;
      if (len & 1) return null;
      sizes.push(len / 2, len / 2);
      break;
    case 2: {
      count = 2;
      const first = parseSize(packet, offset);
      if (!first || first.size < 0 || first.size > len - first.bytes) return null;
      offset += first.bytes;
      len -= first.bytes;
      sizes.push(first.size, len - first.size);
      break;
    }
    default: {
      if (len < 1) return null;
      const ch = packet[offset]!;
      count = ch & 0x3f;
      if (count <= 0 || count > 48) return null;
      offset += 1;
      len -= 1;

      if (ch & 0x40) {
        let pad = 0;
        while (true) {
          if (len <= 0) return null;
          const p = packet[offset]!;
          offset += 1;
          len -= 1;
          const tmp = p === 255 ? 254 : p;
          len -= tmp;
          pad += tmp;
          if (p !== 255) break;
        }
        if (len < 0) return null;
        void pad;
      }

      cbr = !!(ch & 0x80);
      if (!cbr) {
        let remaining = len;
        for (let i = 0; i < count - 1; i++) {
          const parsed = parseSize(packet, offset);
          if (!parsed || parsed.size < 0 || parsed.size > remaining - parsed.bytes) return null;
          offset += parsed.bytes;
          remaining -= parsed.bytes;
          sizes.push(parsed.size);
          remaining -= parsed.size;
        }
        if (remaining < 0) return null;
        sizes.push(remaining);
      } else {
        if (len % count !== 0) return null;
        const frameSize = len / count;
        for (let i = 0; i < count; i++) sizes.push(frameSize);
      }
      break;
    }
  }

  if (sizes.some((s) => s < 0 || s > 1275)) return null;

  const singleToc = toc & 0xfc;
  const frames: Buffer[] = [];
  for (const size of sizes) {
    if (offset + size > packet.length) return null;
    const payload = packet.subarray(offset, offset + size);
    offset += size;
    if (count === 1 && mode === 0) {
      frames.push(packet);
    } else {
      frames.push(Buffer.concat([Buffer.from([singleToc]), payload]));
    }
  }

  return frames;
}
