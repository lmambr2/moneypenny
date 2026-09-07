// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! E-BOX — greedy fewest-crate breakdown. No 3D packing.

pub const STANDARD_CRATE_SCU: &[u32] = &[32, 24, 16, 8, 4, 2, 1];

#[derive(Debug, Clone, PartialEq)]
pub struct BoxCount {
    pub size_scu: u32,
    pub count: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BoxBreakdown {
    pub scu: u32,
    pub crates: Vec<BoxCount>,
    pub total_boxes: u32,
    pub label: String,
    pub largest_crate: u32,
}

pub fn whole_scu(scu: f64) -> u32 {
    if !scu.is_finite() || scu <= 0.0 {
        return 0;
    }
    scu.ceil() as u32
}

pub fn calculate_boxes(scu: f64) -> BoxBreakdown {
    let mut remaining = whole_scu(scu);
    let packed = remaining;
    let mut crates = Vec::new();
    for &size in STANDARD_CRATE_SCU {
        if remaining < size {
            continue;
        }
        let count = remaining / size;
        if count > 0 {
            crates.push(BoxCount {
                size_scu: size,
                count,
            });
            remaining -= count * size;
        }
    }
    if remaining > 0 {
        if let Some(one) = crates.iter_mut().find(|c| c.size_scu == 1) {
            one.count += remaining;
        } else {
            crates.push(BoxCount {
                size_scu: 1,
                count: remaining,
            });
        }
    }
    let total_boxes = crates.iter().map(|c| c.count).sum();
    let largest_crate = crates.first().map(|c| c.size_scu).unwrap_or(0);
    BoxBreakdown {
        scu: packed,
        label: format_box_label(&crates),
        crates,
        total_boxes,
        largest_crate,
    }
}

pub fn format_box_label(crates: &[BoxCount]) -> String {
    if crates.is_empty() {
        return String::new();
    }
    crates
        .iter()
        .map(|c| format!("{}×{}", c.count, c.size_scu))
        .collect::<Vec<_>>()
        .join(" + ")
}

pub fn largest_crate_that_fits(max_box: u32) -> Option<u32> {
    STANDARD_CRATE_SCU.iter().copied().find(|&s| s <= max_box)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sixty_four_is_two_thirty_twos() {
        let b = calculate_boxes(64.0);
        assert_eq!(b.total_boxes, 2);
        assert_eq!(b.label, "2×32");
    }

    #[test]
    fn forty_splits() {
        let b = calculate_boxes(40.0);
        assert_eq!(b.label, "1×32 + 1×8");
    }
}
