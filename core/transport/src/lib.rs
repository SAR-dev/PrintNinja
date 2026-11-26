//! Transports: raw TCP / JetDirect, the Windows spooler, IPP/CUPS and
//! Bluetooth (RFCOMM on Linux, the paired device's COM port on Windows) —
//! the four phase 3 adapters (plan §5.6).
//!
//! A transport moves bytes to one printer and reports byte-level facts.
//! It is language-blind and profile-blind (plan §5.11): it does not know
//! what the bytes mean or which printer model is on the other end. Pacing,
//! deadlines and close delay arrive in a [`SendPlan`] that the job
//! orchestrator derives from the profile.

pub mod bluetooth;
pub mod ipp;
pub mod spooler;
mod tcp;

#[cfg(any(target_os = "linux", target_os = "windows"))]
pub use bluetooth::BluetoothTransport;
pub use ipp::IppTransport;
#[cfg(windows)]
pub use spooler::WindowsSpoolerTransport;
pub use tcp::TcpTransport;

use std::time::Duration;

/// Pacing and deadlines for one job, derived from the profile by the job
/// orchestrator.
#[derive(Debug, Clone)]
pub struct SendPlan {
    /// Bytes written per paced chunk.
    pub chunk_bytes: u32,
    /// Sleep between chunks, in milliseconds.
    pub pause_ms: u32,
    /// After the last byte, hold the connection open this long so the
    /// printer can finish the job before the socket closes.
    pub close_delay_ms: u32,
    /// Give up on the connect after this long.
    pub connect: Duration,
    /// Give up on a stalled write after this long.
    pub send: Duration,
    /// Give up on a status reply after this long. Silence is **not** an
    /// error: a printer that never answers must still print (plan §5.7).
    pub reply: Duration,
}

impl Default for SendPlan {
    fn default() -> Self {
        SendPlan {
            chunk_bytes: 1024,
            pause_ms: 10,
            close_delay_ms: 500,
            connect: Duration::from_secs(10),
            send: Duration::from_secs(30),
            reply: Duration::from_secs(3),
        }
    }
}

/// Byte-level facts about one unit (e.g. one label) of a job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnitReport {
    /// Bytes of this unit that reached the kernel before the failure
    /// (the whole unit on success).
    pub bytes_written: u64,
    /// Set when the write failed.
    pub error: Option<SendError>,
}

impl UnitReport {
    pub fn ok(bytes: u64) -> Self {
        UnitReport {
            bytes_written: bytes,
            error: None,
        }
    }
}

/// A byte-level failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendError {
    /// The connection could not be established.
    Connect(String),
    /// The peer closed the connection while sending.
    ClosedByPeer,
    /// The write stalled past the send deadline (the peer is not reading).
    SendDeadline,
    /// The connection was lost after some bytes were already written.
    Io(String),
}

impl SendError {
    /// A retry is safe only when **no byte** was accepted by the peer; a
    /// retry after partial delivery would print duplicates (plan §5.6).
    /// The job checks the flushed byte count on top of this.
    pub fn retryable(&self) -> bool {
        matches!(self, Self::Connect(_))
    }

    /// Plain-words reason for the job result.
    pub fn reason(&self) -> String {
        match self {
            SendError::Connect(msg) => format!("could not connect: {msg}"),
            SendError::ClosedByPeer => "the connection was closed by the printer".to_string(),
            SendError::SendDeadline => "the printer stopped reading (send deadline)".to_string(),
            SendError::Io(msg) => format!("connection lost: {msg}"),
        }
    }
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.reason())
    }
}

impl std::error::Error for SendError {}

/// A transport moves bytes to one printer and reports byte-level facts.
pub trait Transport {
    /// Write one unit with the plan's pacing (chunked, with pauses).
    /// The unit is all-or-nothing from the job's point of view: a failed
    /// unit does not count as printed, but its `bytes_written` still
    /// counts against retry safety.
    fn send_unit(&mut self, data: &[u8], plan: &SendPlan) -> UnitReport;

    /// Send a status query on the same connection and wait for a reply.
    /// `complete` says when the reply is complete enough to stop reading
    /// (the transport is language-blind; the orchestrator supplies the
    /// dialect's shape). `Ok(None)` is silence — not an error.
    fn status_reply(
        &mut self,
        query: &[u8],
        deadline: Duration,
        complete: &dyn Fn(&[u8]) -> bool,
    ) -> Result<Option<Vec<u8>>, SendError>;

    /// Hold the connection open for the plan's close delay, then close it.
    fn finish(&mut self, plan: &SendPlan);
}
