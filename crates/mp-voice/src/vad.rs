// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Energy VAD (`SilenceSegmenter`). Silero ONNX stays out of process (Node
//! `onnxruntime-node`); rust uses RMS and STT-sidecar keyword as KWS.

/// Downmix interleaved s16 to mono and decimate 48 kHz → 16 kHz (Silero v5).
pub fn to_mono_16k(pcm: &[u8], sample_rate: u32, channels: u32) -> Vec<f32> {
    let ch = channels.max(1) as usize;
    let frame_count = pcm.len() / 2 / ch;
    let mut mono = Vec::with_capacity(frame_count);
    for i in 0..frame_count {
        let mut sum = 0i32;
        for c in 0..ch {
            let off = (i * ch + c) * 2;
            if off + 1 < pcm.len() {
                sum += i16::from_le_bytes([pcm[off], pcm[off + 1]]) as i32;
            }
        }
        mono.push((sum as f32 / ch as f32) / 32768.0);
    }
    if sample_rate == 16_000 {
        return mono;
    }
    let ratio = sample_rate as f32 / 16_000.0;
    if ratio <= 0.0 {
        return mono;
    }
    let out_len = (mono.len() as f32 / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    if (ratio - ratio.round()).abs() < f32::EPSILON {
        let step = ratio.round() as usize;
        for i in 0..out_len {
            let mut s = 0.0;
            for k in 0..step {
                s += *mono.get(i * step + k).unwrap_or(&0.0);
            }
            out.push(s / step as f32);
        }
        return out;
    }
    for i in 0..out_len {
        out.push(*mono.get((i as f32 * ratio).floor() as usize).unwrap_or(&0.0));
    }
    out
}

use mp_audio::pcm_rms;

#[derive(Debug, Clone)]
pub struct SegmenterOptions {
    pub sample_rate: u32,
    pub channels: u32,
    pub energy_threshold: f64,
    pub hangover_ms: f64,
    pub min_speech_ms: f64,
    pub max_utterance_ms: f64,
}

impl Default for SegmenterOptions {
    fn default() -> Self {
        Self {
            sample_rate: 16_000,
            channels: 1,
            energy_threshold: 500.0,
            hangover_ms: 600.0,
            min_speech_ms: 250.0,
            max_utterance_ms: 12_000.0,
        }
    }
}

/// RMS energy end-pointer. Pre-speech silence is dropped; hangover ends a turn.
pub struct SilenceSegmenter {
    opts: SegmenterOptions,
    chunks: Vec<u8>,
    speaking: bool,
    speech_ms: f64,
    silence_ms: f64,
    buffered_ms: f64,
}

impl SilenceSegmenter {
    pub fn new(opts: SegmenterOptions) -> Self {
        Self {
            opts,
            chunks: Vec::new(),
            speaking: false,
            speech_ms: 0.0,
            silence_ms: 0.0,
            buffered_ms: 0.0,
        }
    }

    pub fn for_teamspeak(energy_threshold: f64) -> Self {
        Self::new(SegmenterOptions {
            sample_rate: 48_000,
            channels: 1,
            energy_threshold,
            hangover_ms: 600.0,
            min_speech_ms: 250.0,
            max_utterance_ms: 12_000.0,
        })
    }

    fn frame_ms(&self, pcm: &[u8]) -> f64 {
        let ch = self.opts.channels.max(1) as f64;
        let samples_per_channel = (pcm.len() as f64) / 2.0 / ch;
        (samples_per_channel / self.opts.sample_rate as f64) * 1000.0
    }

    /// Feed a PCM frame. Returns a completed utterance when end-pointed.
    pub fn push(&mut self, pcm: &[u8]) -> Option<Vec<u8>> {
        if pcm.len() < 2 {
            return None;
        }
        let ms = self.frame_ms(pcm);
        let rms = pcm_rms(pcm).unwrap_or(0.0);
        let is_speech = rms >= self.opts.energy_threshold;

        if is_speech {
            self.speaking = true;
            self.silence_ms = 0.0;
            self.chunks.extend_from_slice(pcm);
            self.speech_ms += ms;
            self.buffered_ms += ms;
            if self.buffered_ms >= self.opts.max_utterance_ms {
                return Some(self.complete());
            }
            return None;
        }

        if !self.speaking {
            return None;
        }
        self.chunks.extend_from_slice(pcm);
        self.silence_ms += ms;
        self.buffered_ms += ms;
        if self.silence_ms >= self.opts.hangover_ms {
            if self.speech_ms >= self.opts.min_speech_ms {
                return Some(self.complete());
            }
            self.reset();
            return None;
        }
        None
    }

    pub fn flush(&mut self) -> Option<Vec<u8>> {
        if self.speaking && self.speech_ms >= self.opts.min_speech_ms {
            return Some(self.complete());
        }
        self.reset();
        None
    }

    fn complete(&mut self) -> Vec<u8> {
        let out = std::mem::take(&mut self.chunks);
        self.reset();
        out
    }

    fn reset(&mut self) {
        self.chunks.clear();
        self.speaking = false;
        self.speech_ms = 0.0;
        self.silence_ms = 0.0;
        self.buffered_ms = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 16_000;

    fn frame(amp: i16, ms: u32) -> Vec<u8> {
        let samples = (SR * ms) / 1000;
        let mut buf = vec![0u8; (samples * 2) as usize];
        for i in 0..samples as usize {
            let b = amp.to_le_bytes();
            buf[i * 2] = b[0];
            buf[i * 2 + 1] = b[1];
        }
        buf
    }

    fn opts() -> SegmenterOptions {
        SegmenterOptions {
            sample_rate: SR,
            channels: 1,
            energy_threshold: 500.0,
            hangover_ms: 40.0,
            min_speech_ms: 40.0,
            max_utterance_ms: 200.0,
        }
    }

    #[test]
    fn drops_pre_speech_silence_and_emits_after_hangover() {
        let mut seg = SilenceSegmenter::new(opts());
        let speech = frame(8000, 20);
        let silence = frame(0, 20);
        assert!(seg.push(&silence).is_none());
        assert!(seg.push(&speech).is_none());
        assert!(seg.push(&speech).is_none());
        assert!(seg.push(&silence).is_none());
        let out = seg.push(&silence).expect("utterance");
        assert_eq!(out.len(), 4 * speech.len());
    }

    #[test]
    fn discards_blips_shorter_than_min_speech() {
        let mut seg = SilenceSegmenter::new(opts());
        let speech = frame(8000, 20);
        let silence = frame(0, 20);
        assert!(seg.push(&speech).is_none());
        assert!(seg.push(&silence).is_none());
        assert!(seg.push(&silence).is_none());
        seg.push(&speech);
        seg.push(&speech);
        seg.push(&silence);
        assert!(seg.push(&silence).is_some());
    }

    #[test]
    fn force_flushes_overlong_utterance() {
        let mut opts = opts();
        opts.max_utterance_ms = 60.0;
        let mut seg = SilenceSegmenter::new(opts);
        let speech = frame(8000, 20);
        assert!(seg.push(&speech).is_none());
        assert!(seg.push(&speech).is_none());
        let out = seg.push(&speech).expect("forced");
        assert_eq!(out.len(), 3 * speech.len());
    }

    #[test]
    fn flush_emits_buffered_speech() {
        let mut seg = SilenceSegmenter::new(opts());
        let speech = frame(8000, 20);
        seg.push(&speech);
        seg.push(&speech);
        assert!(seg.flush().is_some());
        assert!(seg.flush().is_none());
    }

    #[test]
    fn flush_without_speech_is_none() {
        let mut seg = SilenceSegmenter::new(opts());
        seg.push(&frame(0, 20));
        assert!(seg.flush().is_none());
    }

    #[test]
    fn mono16k_decimates_48k_by_three() {
        let mut pcm = vec![0u8; 48 * 2];
        for i in 0..48 {
            let v = (i as i16).to_le_bytes();
            pcm[i * 2] = v[0];
            pcm[i * 2 + 1] = v[1];
        }
        let out = to_mono_16k(&pcm, 48_000, 1);
        assert_eq!(out.len(), 16);
    }
}
