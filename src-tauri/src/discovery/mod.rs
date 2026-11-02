pub mod mdns;
pub mod types;

pub use mdns::{browse_peers, browse_printers, start_advertise, stop_advertise};
pub use types::{DiscoveredPeer, DiscoveredPrinter};
