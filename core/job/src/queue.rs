//! One job at a time per printer (plan §5.7): jobs for the same printer
//! are serialized; jobs for different printers may run in parallel.
//!
//! The queue is deliberately dumb — it holds a per-printer-id lock and
//! hands it out. Deciding *what* to print while holding it is the caller's
//! job, which keeps this crate free of scheduling policy.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Serializes job execution per printer.
#[derive(Default)]
pub struct JobQueue {
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl JobQueue {
    pub fn new() -> Self {
        JobQueue::default()
    }

    /// Run `job` with this printer's turn. Blocks until every earlier job
    /// for the same `printer_id` has finished; returns `job`'s result.
    pub fn run_serialized<R>(&self, printer_id: &str, job: impl FnOnce() -> R) -> R {
        let turn = self.turn(printer_id);
        let _guard = turn.lock().unwrap_or_else(|e| e.into_inner());
        job()
    }

    fn turn(&self, printer_id: &str) -> Arc<Mutex<()>> {
        let mut locks = self.locks.lock().unwrap_or_else(|e| e.into_inner());
        locks
            .entry(printer_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn same_printer_is_serialized() {
        let queue = Arc::new(JobQueue::new());
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for _ in 0..4 {
            let active = Arc::clone(&active);
            let peak = Arc::clone(&peak);
            let queue = Arc::clone(&queue);
            handles.push(std::thread::spawn(move || {
                queue.run_serialized("printer-a", || {
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    std::thread::sleep(std::time::Duration::from_millis(20));
                    active.fetch_sub(1, Ordering::SeqCst);
                    true
                })
            }));
        }
        for h in handles {
            assert!(h.join().unwrap());
        }
        assert_eq!(
            peak.load(Ordering::SeqCst),
            1,
            "two jobs for one printer overlapped"
        );
    }

    #[test]
    fn different_printers_do_not_wait_for_each_other() {
        // Record each job's (start, end) and assert the two turns
        // overlapped — the two printers were serviced in parallel.
        type Span = (std::time::Instant, std::time::Instant);
        let queue = Arc::new(JobQueue::new());
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let span_a = Arc::new(std::sync::Mutex::new(None));
        let span_b = Arc::new(std::sync::Mutex::new(None));

        let run_job = |queue: Arc<JobQueue>,
                       barrier: Arc<std::sync::Barrier>,
                       printer: &'static str,
                       span: Arc<std::sync::Mutex<Option<Span>>>| {
            let h = std::thread::spawn(move || {
                barrier.wait(); // both threads enter at the same time
                let start = std::time::Instant::now();
                queue.run_serialized(printer, || {
                    std::thread::sleep(std::time::Duration::from_millis(300));
                });
                *span.lock().unwrap() = Some((start, std::time::Instant::now()));
            });
            h
        };

        let h1 = run_job(
            Arc::clone(&queue),
            Arc::clone(&barrier),
            "printer-a",
            Arc::clone(&span_a),
        );
        let h2 = run_job(queue, barrier, "printer-b", span_b.clone());
        h1.join().unwrap();
        h2.join().unwrap();

        let (sa, ea) = span_a.lock().unwrap().unwrap();
        let (sb, eb) = span_b.lock().unwrap().unwrap();
        assert!(
            sa <= eb && sb <= ea,
            "the two jobs did not overlap: a={sa:?}..{ea:?}, b={sb:?}..{eb:?}"
        );
    }
}
