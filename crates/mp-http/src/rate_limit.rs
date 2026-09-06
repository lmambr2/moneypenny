// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! In-memory token bucket (port of `web/middleware/rateLimit.ts`).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

struct Bucket {
    tokens: f64,
    last_refill: Instant,
}

pub struct RateLimiter {
    capacity: f64,
    refill_per_sec: f64,
    buckets: Mutex<HashMap<String, Bucket>>,
}

impl RateLimiter {
    pub fn new(capacity: u32, refill_per_sec: f64) -> Self {
        Self {
            capacity: capacity as f64,
            refill_per_sec,
            buckets: Mutex::new(HashMap::new()),
        }
    }

    /// Returns Ok(()) or the retry-after seconds.
    pub fn take(&self, key: &str) -> Result<(), u64> {
        let now = Instant::now();
        let mut map = self.buckets.lock().expect("rate limiter poisoned");
        map.retain(|_, b| now.duration_since(b.last_refill) < Duration::from_secs(600));
        let b = map.entry(key.to_string()).or_insert(Bucket {
            tokens: self.capacity,
            last_refill: now,
        });
        let elapsed = now.duration_since(b.last_refill).as_secs_f64();
        b.tokens = (b.tokens + elapsed * self.refill_per_sec).min(self.capacity);
        b.last_refill = now;
        if b.tokens >= 1.0 {
            b.tokens -= 1.0;
            Ok(())
        } else {
            let wait = ((1.0 - b.tokens) / self.refill_per_sec).ceil() as u64;
            Err(wait.max(1))
        }
    }
}
