use serde::{Deserialize, Serialize};

/// Printer discovered via mDNS.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredPrinter {
    pub name: String,
    pub host: String,
    pub port: u16,
    /// `ipp` for `_ipp._tcp` / `_ipps._tcp`, `raw_tcp` for `_pdl-datastream._tcp` / `_printer._tcp`
    pub kind: String,
    /// `rp` TXT value without leading slash, if present.
    #[serde(default)]
    pub resource_path: Option<String>,
    /// Full service name for dedupe/debug.
    #[serde(default)]
    pub fullname: String,
}

/// PC (PrintNinja provider) discovered via `_printninja._tcp`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredPeer {
    pub host: String,
    pub port: u16,
    pub provider_id: String,
    pub platform: String,
    /// Wire protocol version (TXT `prot`, default 1).
    pub protocol: u32,
    pub version: String,
    pub name: String,
    #[serde(default)]
    pub fullname: String,
}
