// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Local-time window for ID3 enrich. Hours are wall-clock. Start inclusive, end exclusive.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HourWindow {
    pub start_hour: u32,
    pub end_hour: u32,
}

pub const NIGHT_INDEX_WINDOW: HourWindow = HourWindow {
    start_hour: 2,
    end_hour: 7,
};

#[derive(Debug, Clone, Copy)]
pub struct CivilClock {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
}

impl CivilClock {
    pub fn at(year: i32, month: u32, day: u32, hour: u32, minute: u32, second: u32) -> Self {
        Self {
            year,
            month,
            day,
            hour,
            minute,
            second,
        }
    }
}

fn hour_stamp(now: &CivilClock) -> f64 {
    now.hour as f64 + now.minute as f64 / 60.0 + now.second as f64 / 3600.0
}

pub fn is_in_local_hour_window(now: &CivilClock, window: HourWindow) -> bool {
    if window.start_hour == window.end_hour {
        return true;
    }
    let h = hour_stamp(now);
    if window.start_hour < window.end_hour {
        h >= window.start_hour as f64 && h < window.end_hour as f64
    } else {
        h >= window.start_hour as f64 || h < window.end_hour as f64
    }
}

fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp as u64 + 2) / 5 + d as u64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era as i64 * 146097 + doe as i64 - 719468
}

fn epoch_ms(now: &CivilClock) -> i64 {
    let days = days_from_civil(now.year, now.month, now.day);
    days * 86_400_000 + now.hour as i64 * 3_600_000 + now.minute as i64 * 60_000 + now.second as i64 * 1000
}

pub fn ms_until_window_opens(now: &CivilClock, window: HourWindow) -> i64 {
    if is_in_local_hour_window(now, window) {
        return 0;
    }
    let mut open = *now;
    open.hour = window.start_hour;
    open.minute = 0;
    open.second = 0;
    if epoch_ms(&open) <= epoch_ms(now) {
        let next = epoch_ms(&open) + 86_400_000;
        return next - epoch_ms(now);
    }
    epoch_ms(&open) - epoch_ms(now)
}

pub fn ms_until_window_closes(now: &CivilClock, window: HourWindow) -> i64 {
    if !is_in_local_hour_window(now, window) {
        return 0;
    }
    let mut close = *now;
    close.hour = window.end_hour;
    close.minute = 0;
    close.second = 0;
    let mut close_ms = epoch_ms(&close);
    if window.end_hour <= window.start_hour && now.hour >= window.start_hour {
        close_ms += 86_400_000;
    } else if close_ms <= epoch_ms(now) {
        close_ms += 86_400_000;
    }
    (close_ms - epoch_ms(now)).max(0)
}

/// ID3 runs only inside the night window. Filename indexing does not.
pub fn id3_enrich_due(now: &CivilClock, window: HourWindow) -> bool {
    is_in_local_hour_window(now, window)
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Id3Tags {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub genre: Option<String>,
}

/// Read ID3v2.3/2.4 text frames (TIT2, TPE1, TALB, TCON). Missing tag is `None`.
pub fn parse_id3v2(bytes: &[u8]) -> Option<Id3Tags> {
    if bytes.len() < 10 || &bytes[0..3] != b"ID3" {
        return None;
    }
    let ver = bytes[3];
    if ver < 3 {
        return None;
    }
    // The 10-byte header size is synchsafe in both 2.3 and 2.4. Frame sizes are not.
    let body_len = unsyncsafe(&bytes[6..10])?;
    let end = (10 + body_len).min(bytes.len());
    let mut tags = Id3Tags::default();
    let mut off = 10usize;
    if bytes[5] & 0x40 != 0 {
        let skip = extended_header_len(ver, bytes, off)?;
        off = off.saturating_add(skip);
    }
    while off + 10 <= end {
        let id = &bytes[off..off + 4];
        if id[0] == 0 {
            break;
        }
        let size = if ver >= 4 {
            unsyncsafe(&bytes[off + 4..off + 8])?
        } else {
            u32::from_be_bytes(bytes[off + 4..off + 8].try_into().ok()?) as usize
        };
        let data_at = off + 10;
        let data_end = data_at.saturating_add(size).min(bytes.len());
        if data_at < data_end {
            if let Some(text) = frame_text(&bytes[data_at..data_end]) {
                match id {
                    b"TIT2" => tags.title = Some(text),
                    b"TPE1" => tags.artist = Some(text),
                    b"TALB" => tags.album = Some(text),
                    b"TCON" => tags.genre = Some(text),
                    _ => {}
                }
            }
        }
        off = data_end;
    }
    if tags.title.is_none() && tags.artist.is_none() && tags.album.is_none() && tags.genre.is_none() {
        return None;
    }
    Some(tags)
}

fn extended_header_len(ver: u8, bytes: &[u8], off: usize) -> Option<usize> {
    if off + 4 > bytes.len() {
        return None;
    }
    if ver >= 4 {
        unsyncsafe(&bytes[off..off + 4])
    } else {
        let n = u32::from_be_bytes(bytes[off..off + 4].try_into().ok()?) as usize;
        Some(4 + n)
    }
}

fn unsyncsafe(b: &[u8]) -> Option<usize> {
    if b.len() < 4 || b.iter().any(|x| x & 0x80 != 0) {
        return None;
    }
    Some(
        ((b[0] as usize) << 21)
            | ((b[1] as usize) << 14)
            | ((b[2] as usize) << 7)
            | (b[3] as usize),
    )
}

fn frame_text(data: &[u8]) -> Option<String> {
    if data.is_empty() {
        return None;
    }
    let text = match data[0] {
        0 | 3 => String::from_utf8_lossy(&data[1..]).trim_end_matches('\0').trim().to_string(),
        1 => {
            let rest = if data.len() > 2 && data[1] == 0xff { &data[3..] } else { &data[1..] };
            let units: Vec<u16> = rest
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .take_while(|u| *u != 0)
                .collect();
            String::from_utf16_lossy(&units).trim().to_string()
        }
        _ => return None,
    };
    if text.is_empty() { None } else { Some(text) }
}

pub fn civil_now() -> CivilClock {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    unsafe {
        let t = secs as libc::time_t;
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&t, &mut tm).is_null() {
            return CivilClock::at(1970, 1, 1, 0, 0, 0);
        }
        CivilClock {
            year: tm.tm_year + 1900,
            month: (tm.tm_mon + 1) as u32,
            day: tm.tm_mday as u32,
            hour: tm.tm_hour as u32,
            minute: tm.tm_min as u32,
            second: tm.tm_sec as u32,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(h: u32, m: u32) -> CivilClock {
        CivilClock::at(2026, 9, 12, h, m, 0)
    }

    #[test]
    fn night_window_matches_node() {
        assert!(is_in_local_hour_window(&at(2, 0), NIGHT_INDEX_WINDOW));
        assert!(is_in_local_hour_window(&at(6, 59), NIGHT_INDEX_WINDOW));
        assert!(!is_in_local_hour_window(&at(1, 59), NIGHT_INDEX_WINDOW));
        assert!(!is_in_local_hour_window(&at(7, 0), NIGHT_INDEX_WINDOW));
        assert!(!is_in_local_hour_window(&at(15, 0), NIGHT_INDEX_WINDOW));
        assert!(!id3_enrich_due(&at(15, 0), NIGHT_INDEX_WINDOW));
        assert!(id3_enrich_due(&at(3, 0), NIGHT_INDEX_WINDOW));
        assert_eq!(ms_until_window_opens(&at(3, 0), NIGHT_INDEX_WINDOW), 0);
        assert_eq!(ms_until_window_closes(&at(6, 30), NIGHT_INDEX_WINDOW), 30 * 60 * 1000);
        let wait = ms_until_window_opens(&at(15, 0), NIGHT_INDEX_WINDOW);
        assert_eq!(wait, 11 * 3_600_000);
    }

    #[test]
    fn v23_header_size_is_synchsafe_and_skips_an_extended_header() {
        let mut tag = Vec::new();
        tag.extend_from_slice(b"ID3");
        tag.extend_from_slice(&[3, 0, 0x40]);
        tag.extend_from_slice(&[0x00, 0x00, 0x01, 0x48]);
        tag.extend_from_slice(&6u32.to_be_bytes());
        tag.extend_from_slice(&[0; 6]);
        let text = b"\x00Night";
        tag.extend_from_slice(b"TIT2");
        tag.extend_from_slice(&(text.len() as u32).to_be_bytes());
        tag.extend_from_slice(&[0, 0]);
        tag.extend_from_slice(text);
        while tag.len() < 10 + 200 {
            tag.push(0);
        }
        tag.extend_from_slice(b"TIT2");
        tag.extend_from_slice(&6u32.to_be_bytes());
        tag.extend_from_slice(&[0, 0]);
        tag.extend_from_slice(b"\x00Bad!!");
        let parsed = parse_id3v2(&tag).unwrap();
        assert_eq!(parsed.title.as_deref(), Some("Night"));
    }
}
