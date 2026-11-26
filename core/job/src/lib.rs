//! Jobs: the crate that owns the job result states (plan §5.7).
//!
//! The job orchestrator is the only crate that knows what a successful
//! print *means*: it asks the printer before and after, reads the reply in
//! the profile's dialect, paces the bytes per the profile, and reports an
//! honest state — confirmed, unconfirmed, "N of M printed" with the
//! reason, failed, or wrong mode suspected. Transports stay byte-level;
//! profiles stay declarative.

mod queue;
mod run;
mod status;

pub use queue::JobQueue;
#[cfg(any(target_os = "linux", target_os = "windows"))]
pub use run::BtFactory;
#[cfg(windows)]
pub use run::SpoolerFactory;
pub use run::{run, send_plan_from, IppFactory, JobResult, JobSpec, TcpFactory, TransportFactory};
pub use status::{decode, reply_complete, StatusReading};
