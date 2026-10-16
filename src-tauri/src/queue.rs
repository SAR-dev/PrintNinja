use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex, Semaphore};

/// Per-printer job queue with sequential processing
pub struct PrintQueue {
    semaphores: HashMap<String, Arc<Semaphore>>,
    tx: mpsc::Sender<QueueJob>,
}

#[derive(Debug, Clone)]
pub struct QueueJob {
    pub job_id: String,
    pub printer_id: String,
    pub data: Vec<u8>,
    pub mime_type: String,
    pub copies: u32,
}

impl PrintQueue {
    pub fn new() -> (Self, mpsc::Receiver<QueueJob>) {
        let (tx, rx) = mpsc::channel(100);
        let queue = Self {
            semaphores: HashMap::new(),
            tx,
        };
        (queue, rx)
    }

    pub async fn submit(&self, job: QueueJob) -> Result<(), String> {
        self.tx
            .send(job)
            .await
            .map_err(|e| format!("Queue send failed: {}", e))
    }

    pub fn get_semaphore(&mut self, printer_id: &str) -> Arc<Semaphore> {
        self.semaphores
            .entry(printer_id.to_string())
            .or_insert_with(|| Arc::new(Semaphore::new(1)))
            .clone()
    }
}
