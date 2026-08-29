//! RFC 6716 Opus packet split (same rules as `audio/opus-packet.ts`).

use napi::bindgen_prelude::*;
use napi_derive::napi;

pub const OPUS_DTX_MAX_BYTES: u32 = 12;

fn parse_size(data: &[u8], offset: usize) -> Option<(usize, usize)> {
  if offset >= data.len() {
    return None;
  }
  let b0 = data[offset];
  if b0 < 252 {
    Some((b0 as usize, 1))
  } else if offset + 1 >= data.len() {
    None
  } else {
    Some((4 * data[offset + 1] as usize + b0 as usize, 2))
  }
}

/// Split a TeamSpeak Opus voice payload into single-frame packets.
/// Returns an empty vec when the TOC/layout is invalid (JS returns null).
pub fn split_opus_frames(packet: &[u8]) -> Option<Vec<Vec<u8>>> {
  if packet.is_empty() {
    return None;
  }
  let toc = packet[0];
  let mode = toc & 0x03;
  let mut sizes: Vec<usize> = Vec::new();
  let mut offset = 1usize;
  let mut len = packet.len() - 1;
  let count: usize;

  match mode {
    0 => {
      count = 1;
      sizes.push(len);
    }
    1 => {
      count = 2;
      if len & 1 != 0 {
        return None;
      }
      sizes.push(len / 2);
      sizes.push(len / 2);
    }
    2 => {
      count = 2;
      let first = parse_size(packet, offset)?;
      if first.0 > len.saturating_sub(first.1) {
        return None;
      }
      offset += first.1;
      len -= first.1;
      sizes.push(first.0);
      sizes.push(len - first.0);
    }
    _ => {
      if len < 1 {
        return None;
      }
      let ch = packet[offset];
      count = (ch & 0x3f) as usize;
      if count == 0 || count > 48 {
        return None;
      }
      offset += 1;
      len -= 1;

      if ch & 0x40 != 0 {
        loop {
          if len == 0 {
            return None;
          }
          let p = packet[offset];
          offset += 1;
          len -= 1;
          let tmp = if p == 255 { 254 } else { p as usize };
          if tmp > len {
            return None;
          }
          len -= tmp;
          if p != 255 {
            break;
          }
        }
      }

      let cbr = ch & 0x80 != 0;
      if !cbr {
        let mut remaining = len;
        for _ in 0..count - 1 {
          let parsed = parse_size(packet, offset)?;
          if parsed.0 > remaining.saturating_sub(parsed.1) {
            return None;
          }
          offset += parsed.1;
          remaining -= parsed.1;
          sizes.push(parsed.0);
          remaining = remaining.saturating_sub(parsed.0);
        }
        sizes.push(remaining);
      } else {
        if count == 0 || len % count != 0 {
          return None;
        }
        let frame_size = len / count;
        for _ in 0..count {
          sizes.push(frame_size);
        }
      }
    }
  }

  if sizes.iter().any(|&s| s > 1275) {
    return None;
  }

  let single_toc = toc & 0xfc;
  let mut frames = Vec::with_capacity(count);
  for size in sizes {
    if offset + size > packet.len() {
      return None;
    }
    let payload = &packet[offset..offset + size];
    offset += size;
    if count == 1 && mode == 0 {
      frames.push(packet.to_vec());
    } else {
      let mut frame = Vec::with_capacity(1 + payload.len());
      frame.push(single_toc);
      frame.extend_from_slice(payload);
      frames.push(frame);
    }
  }
  Some(frames)
}

#[napi]
pub fn is_dtx_sized_packet(packet: Buffer) -> bool {
  packet.len() as u32 <= OPUS_DTX_MAX_BYTES
}

/// Split a multi-frame Opus packet. Empty array means invalid layout.
#[napi]
pub fn split_opus_packet(packet: Buffer) -> Result<Vec<Buffer>> {
  match split_opus_frames(packet.as_ref()) {
    None => Ok(vec![]),
    Some(frames) => Ok(frames.into_iter().map(Buffer::from).collect()),
  }
}
