// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Event-driven reconnect with exponential backoff.
//! delay = min(baseMs * 2^(attempt-1), maxMs). Single-flight per bot id.
//!
//! Timers are `tokio::spawn` (Send). The reconnect callback is polled on the
//! caller's task via [`ReconnectScheduler::driver`] because tsclient-rs
//! futures hold `std::sync::MutexGuard` across `.await` and are `!Send`.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::mpsc;

pub fn reconnect_delay_ms(attempt: u32, base_ms: u64, max_ms: u64) -> u64 {
    if attempt < 1 {
        return base_ms;
    }
    base_ms
        .saturating_mul(2u64.saturating_pow(attempt - 1))
        .min(max_ms)
}

struct Due {
    id: String,
    attempt: u32,
    generation: u64,
}

struct Inner {
    base_ms: u64,
    max_ms: u64,
    attempts: Mutex<HashMap<String, u32>>,
    pending: Mutex<HashSet<String>>,
    in_flight: Mutex<HashSet<String>>,
    generation: Mutex<HashMap<String, u64>>,
    gen_clock: AtomicU64,
    due_tx: mpsc::UnboundedSender<Due>,
}

#[derive(Clone)]
pub struct ReconnectScheduler {
    inner: Arc<Inner>,
}

pub struct ReconnectDriver {
    due_rx: mpsc::UnboundedReceiver<Due>,
    inner: Arc<Inner>,
}

impl ReconnectScheduler {
    pub fn pair(base_ms: u64, max_ms: u64) -> (Self, ReconnectDriver) {
        let (due_tx, due_rx) = mpsc::unbounded_channel();
        let inner = Arc::new(Inner {
            base_ms,
            max_ms,
            attempts: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashSet::new()),
            in_flight: Mutex::new(HashSet::new()),
            generation: Mutex::new(HashMap::new()),
            gen_clock: AtomicU64::new(0),
            due_tx,
        });
        (
            Self {
                inner: Arc::clone(&inner),
            },
            ReconnectDriver { due_rx, inner },
        )
    }

    fn generation_of(&self, id: &str) -> u64 {
        *self
            .inner
            .generation
            .lock()
            .expect("gen")
            .get(id)
            .unwrap_or(&0)
    }

    fn bump_gen(&self, id: &str) -> u64 {
        let g = self.inner.gen_clock.fetch_add(1, Ordering::SeqCst) + 1;
        self.inner
            .generation
            .lock()
            .expect("gen")
            .insert(id.to_string(), g);
        g
    }

    pub fn is_busy(&self, id: &str) -> bool {
        self.inner.pending.lock().expect("p").contains(id)
            || self.inner.in_flight.lock().expect("f").contains(id)
    }

    pub fn cancel(&self, id: &str) {
        self.inner.pending.lock().expect("p").remove(id);
        self.inner.attempts.lock().expect("a").remove(id);
        self.bump_gen(id);
    }

    pub fn reset(&self, id: &str) {
        self.inner.pending.lock().expect("p").remove(id);
        self.inner.attempts.lock().expect("a").remove(id);
    }

    pub fn get_attempt(&self, id: &str) -> u32 {
        *self
            .inner
            .attempts
            .lock()
            .expect("a")
            .get(id)
            .unwrap_or(&0)
    }

    pub fn schedule(&self, id: &str, reason: &str) {
        if self.is_busy(id) {
            tracing::info!(bot_id = id, reason, "Reconnect already scheduled or in flight");
            return;
        }
        let attempt = {
            let mut a = self.inner.attempts.lock().expect("a");
            let n = a.get(id).copied().unwrap_or(0) + 1;
            a.insert(id.to_string(), n);
            n
        };
        let delay = reconnect_delay_ms(attempt, self.inner.base_ms, self.inner.max_ms);
        let gen_at = self.generation_of(id);
        tracing::warn!(bot_id = id, reason, attempt, delay_ms = delay, "Scheduling reconnect");
        self.inner.pending.lock().expect("p").insert(id.to_string());
        let inner = Arc::clone(&self.inner);
        let id = id.to_string();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            inner.pending.lock().expect("p").remove(&id);
            if inner
                .generation
                .lock()
                .expect("g")
                .get(&id)
                .copied()
                .unwrap_or(0)
                != gen_at
            {
                return;
            }
            let _ = inner.due_tx.send(Due {
                id,
                attempt,
                generation: gen_at,
            });
        });
    }

    pub fn dispose(&self) {
        let ids: Vec<String> = self
            .inner
            .generation
            .lock()
            .expect("g")
            .keys()
            .cloned()
            .chain(self.inner.pending.lock().expect("p").iter().cloned())
            .collect();
        for id in ids {
            self.cancel(&id);
        }
        self.inner.in_flight.lock().expect("f").clear();
    }
}

impl ReconnectDriver {
    /// Poll due reconnects and run `reconnect` on this task (`!Send` OK).
    pub async fn run<F, Fut>(&mut self, reconnect: F)
    where
        F: Fn(String) -> Fut,
        Fut: Future<Output = Result<(), String>>,
    {
        while let Some(due) = self.due_rx.recv().await {
            self.fire(&reconnect, due).await;
        }
    }

    async fn fire<F, Fut>(&self, reconnect: &F, due: Due)
    where
        F: Fn(String) -> Fut,
        Fut: Future<Output = Result<(), String>>,
    {
        let gen_now = self
            .inner
            .generation
            .lock()
            .expect("g")
            .get(&due.id)
            .copied()
            .unwrap_or(0);
        if gen_now != due.generation {
            return;
        }
        if self.inner.in_flight.lock().expect("f").contains(&due.id) {
            return;
        }
        self.inner
            .in_flight
            .lock()
            .expect("f")
            .insert(due.id.clone());
        tracing::info!(bot_id = %due.id, attempt = due.attempt, "Reconnect attempt starting");
        let mut failed = false;
        match reconnect(due.id.clone()).await {
            Ok(()) => {
                let gen_now = self
                    .inner
                    .generation
                    .lock()
                    .expect("g")
                    .get(&due.id)
                    .copied()
                    .unwrap_or(0);
                if gen_now != due.generation {
                    tracing::info!(bot_id = %due.id, "Reconnect finished after cancel — ignoring");
                } else {
                    self.inner.attempts.lock().expect("a").remove(&due.id);
                    tracing::info!(bot_id = %due.id, attempt = due.attempt, "Reconnect attempt succeeded");
                }
            }
            Err(e) => {
                failed = true;
                tracing::error!(bot_id = %due.id, attempt = due.attempt, error = %e, "Reconnect attempt failed");
            }
        }
        self.inner.in_flight.lock().expect("f").remove(&due.id);
        if failed
            && self
                .inner
                .generation
                .lock()
                .expect("g")
                .get(&due.id)
                .copied()
                .unwrap_or(0)
                == due.generation
            && !self.inner.pending.lock().expect("p").contains(&due.id)
        {
            // Reschedule using a cloned scheduler handle.
            ReconnectScheduler {
                inner: Arc::clone(&self.inner),
            }
            .schedule(&due.id, "retry-after-fail");
        }
    }
}

// silence unused import if any
#[allow(dead_code)]
type _Pin = Pin<Box<dyn Future<Output = ()> + Send>>;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering as AtOrd};

    async fn drive_until(sched: ReconnectScheduler, mut driver: ReconnectDriver, n: Arc<AtomicU32>, target: u32, ms: u64) {
        let reconnect = {
            let n = Arc::clone(&n);
            move |_id: String| {
                let n = Arc::clone(&n);
                async move {
                    n.fetch_add(1, AtOrd::SeqCst);
                    Ok(())
                }
            }
        };
        tokio::select! {
            _ = driver.run(reconnect) => {}
            _ = tokio::time::sleep(Duration::from_millis(ms)) => {}
        }
        let _ = sched;
        let _ = target;
    }

    #[test]
    fn delay_grows_and_caps() {
        assert_eq!(reconnect_delay_ms(1, 2000, 60_000), 2000);
        assert_eq!(reconnect_delay_ms(2, 2000, 60_000), 4000);
        assert_eq!(reconnect_delay_ms(3, 2000, 60_000), 8000);
        assert_eq!(reconnect_delay_ms(10, 2000, 60_000), 60_000);
    }

    #[tokio::test]
    async fn schedules_after_base_delay() {
        let n = Arc::new(AtomicU32::new(0));
        let (s, driver) = ReconnectScheduler::pair(30, 1_000);
        s.schedule("a", "drop");
        assert!(s.is_busy("a"));
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(n.load(AtOrd::SeqCst), 0);
        drive_until(s.clone(), driver, Arc::clone(&n), 1, 50).await;
        assert_eq!(n.load(AtOrd::SeqCst), 1);
        assert_eq!(s.get_attempt("a"), 0);
        assert!(!s.is_busy("a"));
    }

    #[tokio::test]
    async fn single_flight() {
        let n = Arc::new(AtomicU32::new(0));
        let (s, driver) = ReconnectScheduler::pair(20, 1_000);
        s.schedule("a", "x");
        s.schedule("a", "x");
        s.schedule("a", "x");
        drive_until(s, driver, n.clone(), 1, 60).await;
        assert_eq!(n.load(AtOrd::SeqCst), 1);
    }

    #[tokio::test]
    async fn cancel_prevents_fire() {
        let n = Arc::new(AtomicU32::new(0));
        let (s, driver) = ReconnectScheduler::pair(40, 1_000);
        s.schedule("c", "x");
        s.cancel("c");
        drive_until(s.clone(), driver, n.clone(), 0, 80).await;
        assert_eq!(n.load(AtOrd::SeqCst), 0);
        assert!(!s.is_busy("c"));
    }

    #[tokio::test]
    async fn backoff_on_fail() {
        let n = Arc::new(AtomicU32::new(0));
        let (s, mut driver) = ReconnectScheduler::pair(20, 200);
        let n2 = Arc::clone(&n);
        let reconnect = move |_id: String| {
            let n2 = Arc::clone(&n2);
            async move {
                let c = n2.fetch_add(1, AtOrd::SeqCst) + 1;
                if c < 3 {
                    Err("fail".into())
                } else {
                    Ok(())
                }
            }
        };
        s.schedule("b", "x");
        tokio::select! {
            _ = driver.run(reconnect) => {}
            _ = tokio::time::sleep(Duration::from_millis(200)) => {}
        }
        assert_eq!(n.load(AtOrd::SeqCst), 3);
        assert_eq!(s.get_attempt("b"), 0);
    }
}
