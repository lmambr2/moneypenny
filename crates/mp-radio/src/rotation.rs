// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Artist/album separation for `!selecttracks`. Port of `orderKeysWithSeparation`.

#[derive(Debug, Clone)]
pub struct RotationMeta {
    pub artist: String,
    pub album: String,
}

#[derive(Debug, Clone, Copy)]
pub struct SeparationPolicy {
    pub enabled: bool,
    pub artist_window: usize,
    pub album_window: usize,
    pub relax_on_empty: bool,
}

impl Default for SeparationPolicy {
    fn default() -> Self {
        Self {
            enabled: true,
            artist_window: 4,
            album_window: 6,
            relax_on_empty: true,
        }
    }
}

pub fn order_keys_with_separation(
    keys: &[String],
    meta_of: impl Fn(&str) -> Option<RotationMeta>,
    policy: SeparationPolicy,
) -> Vec<String> {
    if !policy.enabled || keys.len() <= 1 {
        return keys.to_vec();
    }
    let mut remaining = keys.to_vec();
    let mut out = Vec::new();
    while !remaining.is_empty() {
        let mut pick = None;
        for (i, key) in remaining.iter().enumerate() {
            if fits(key, &out, &meta_of, &policy) {
                pick = Some(i);
                break;
            }
        }
        let idx = if let Some(i) = pick {
            i
        } else if !policy.relax_on_empty {
            out.extend(remaining.drain(..));
            break;
        } else {
            softest(&remaining, &out, &meta_of, &policy)
        };
        if idx >= remaining.len() {
            break;
        }
        out.push(remaining.remove(idx));
    }
    out
}

fn norm(s: &str) -> String {
    s.trim().to_lowercase()
}

fn fits(key: &str, placed: &[String], meta_of: &impl Fn(&str) -> Option<RotationMeta>, policy: &SeparationPolicy) -> bool {
    let Some(meta) = meta_of(key) else {
        return true;
    };
    let artist = norm(&meta.artist);
    let album = norm(&meta.album);
    if artist.is_empty() && album.is_empty() {
        return true;
    }
    let artist_win = policy.artist_window.min(placed.len());
    let album_win = policy.album_window.min(placed.len());
    if !artist.is_empty() {
        let start = placed.len().saturating_sub(artist_win);
        for prev in &placed[start..] {
            if norm(&meta_of(prev).map(|m| m.artist).unwrap_or_default()) == artist {
                return false;
            }
        }
    }
    if !album.is_empty() {
        let start = placed.len().saturating_sub(album_win);
        for prev in &placed[start..] {
            if norm(&meta_of(prev).map(|m| m.album).unwrap_or_default()) == album {
                return false;
            }
        }
    }
    true
}

fn softest(
    remaining: &[String],
    placed: &[String],
    meta_of: &impl Fn(&str) -> Option<RotationMeta>,
    policy: &SeparationPolicy,
) -> usize {
    let mut best = 0usize;
    let mut best_score = i64::MAX;
    for (i, key) in remaining.iter().enumerate() {
        let meta = meta_of(key);
        let artist = meta.as_ref().map(|m| norm(&m.artist)).unwrap_or_default();
        let album = meta.as_ref().map(|m| norm(&m.album)).unwrap_or_default();
        let mut score = 0i64;
        let window = policy.artist_window.max(policy.album_window);
        for d in 1..=window {
            let Some(prev) = placed.get(placed.len().saturating_sub(d)) else {
                break;
            };
            let pm = meta_of(prev);
            if !artist.is_empty() && pm.as_ref().is_some_and(|m| norm(&m.artist) == artist) {
                score += (policy.artist_window as i64) - d as i64 + 1;
            }
            if !album.is_empty() && pm.as_ref().is_some_and(|m| norm(&m.album) == album) {
                score += ((policy.album_window as i64) - d as i64 + 1) / 2;
            }
        }
        if score < best_score {
            best_score = score;
            best = i;
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn separates_repeated_artists() {
        let keys = vec!["a1".into(), "a2".into(), "b".into()];
        let ordered = order_keys_with_separation(
            &keys,
            |k| {
                Some(RotationMeta {
                    artist: if k.starts_with('a') { "Alpha".into() } else { "Beta".into() },
                    album: k.into(),
                })
            },
            SeparationPolicy::default(),
        );
        assert_eq!(ordered, vec!["a1", "b", "a2"]);
    }
}
