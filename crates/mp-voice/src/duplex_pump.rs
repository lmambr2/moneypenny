// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Talker PCM → 48 kHz stereo 20 ms frames. Does not touch the music encoder.
//! The caller sends a frame only while the floor allows it.

pub const PCM_FRAME_BYTES: usize = 3840;

/// Duplicate each 24 kHz mono sample into a 48 kHz stereo pair.
pub fn talker_mono_24k_to_stereo_48k(pcm: &[u8]) -> Vec<u8> {
    let samples = pcm.len() / 2;
    let mut out = vec![0u8; samples * 8];
    for i in 0..samples {
        let s = i16::from_le_bytes([pcm[i * 2], pcm[i * 2 + 1]]);
        let base = i * 8;
        for off in [0, 2, 4, 6] {
            out[base + off..base + off + 2].copy_from_slice(&s.to_le_bytes());
        }
    }
    out
}

/// 48 kHz interleaved → 24 kHz mono (left if stereo). User PCM into the Talker.
pub fn downsample_48k_to_24k_mono(pcm: &[u8], channels: u32) -> Vec<u8> {
    let ch = channels.max(1) as usize;
    let frame_bytes = ch * 2;
    if frame_bytes == 0 {
        return Vec::new();
    }
    let frames = pcm.len() / frame_bytes;
    let mut out = Vec::with_capacity((frames / 2 + 1) * 2);
    let mut i = 0;
    while i < frames {
        let src = i * frame_bytes;
        out.extend_from_slice(&pcm[src..src + 2]);
        i += 2;
    }
    out
}

#[derive(Debug, Default)]
pub struct DuplexPcmPump {
    pending: Vec<u8>,
}

impl DuplexPcmPump {
    /// Returns complete 20 ms stereo frames. Drops the buffer when send is disallowed.
    pub fn push(&mut self, mono24k: &[u8], allows: bool) -> Vec<Vec<u8>> {
        if !allows || mono24k.len() < 2 {
            self.pending.clear();
            return Vec::new();
        }
        self.pending
            .extend_from_slice(&talker_mono_24k_to_stereo_48k(mono24k));
        let mut frames = Vec::new();
        while self.pending.len() >= PCM_FRAME_BYTES {
            if !allows {
                self.pending.clear();
                return frames;
            }
            let frame = self.pending.drain(..PCM_FRAME_BYTES).collect();
            frames.push(frame);
        }
        frames
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ninety_ms_of_talker_pcm_is_two_opus_slots() {
        let mut samples = Vec::new();
        for i in 0..960i16 {
            samples.extend_from_slice(&i.to_le_bytes());
        }
        let mut pump = DuplexPcmPump::default();
        let frames = pump.push(&samples, true);
        assert_eq!(frames.len(), 2);
        assert!(frames.iter().all(|f| f.len() == PCM_FRAME_BYTES));
        let dropped = pump.push(&samples, false);
        assert!(dropped.is_empty());
    }

    #[test]
    fn downsample_keeps_every_other_left_sample() {
        let pcm = [1i16, 2, 3, 4, 5, 6];
        let mut raw = Vec::new();
        for s in pcm {
            raw.extend_from_slice(&s.to_le_bytes());
        }
        let mono = downsample_48k_to_24k_mono(&raw, 2);
        assert_eq!(i16::from_le_bytes([mono[0], mono[1]]), 1);
        assert_eq!(i16::from_le_bytes([mono[2], mono[3]]), 5);
    }
}
