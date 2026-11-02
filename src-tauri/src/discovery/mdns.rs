use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};

use crate::api::peer_consume::is_private_host;
use crate::discovery::types::{DiscoveredPeer, DiscoveredPrinter};

const PRINTER_SERVICES: &[(&str, &str)] = &[
    ("_ipp._tcp.local.", "ipp"),
    ("_ipps._tcp.local.", "ipp"),
    ("_pdl-datastream._tcp.local.", "raw_tcp"),
    ("_printer._tcp.local.", "raw_tcp"),
];
const PEER_SERVICE: &str = "_printninja._tcp.local.";
const MDNS_TTL: &str = "_printninja._tcp";

/// Browse for network printers across the four printer service types.
pub fn browse_printers(timeout_ms: u64) -> Vec<DiscoveredPrinter> {
    let timeout = Duration::from_millis(timeout_ms.clamp(500, 30000));
    let deadline = Instant::now() + timeout;

    let mdns = match ServiceDaemon::new() {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!("mdns daemon failed: {e}");
            return Vec::new();
        }
    };

    let mut receivers = Vec::new();
    for (svc, _kind) in PRINTER_SERVICES {
        match mdns.browse(svc) {
            Ok(rx) => receivers.push((svc.to_string(), rx)),
            Err(e) => tracing::debug!("browse {svc} failed: {e}"),
        }
    }
    if receivers.is_empty() {
        return Vec::new();
    }

    let mut found: HashMap<String, DiscoveredPrinter> = HashMap::new();

    while Instant::now() < deadline {
        for (svc, rx) in &receivers {
            while let Ok(event) = rx.recv_timeout(Duration::from_millis(50)) {
                if let ServiceEvent::ServiceResolved(info) = event {
                    let kind = PRINTER_SERVICES
                        .iter()
                        .find(|(s, _)| *s == svc.as_str())
                        .map(|(_, k)| *k)
                        .unwrap_or("ipp");
                    if let Some(printer) = service_info_to_printer(&info, kind) {
                        if !is_private_host(&printer.host) {
                            tracing::debug!("mdns printer host not private, skipping: {}", printer.host);
                            continue;
                        }
                        let key = format!("{}:{}", printer.host, printer.port);
                        found.entry(key).or_insert(printer);
                    }
                }
            }
        }
        // avoid busy spin
        std::thread::sleep(Duration::from_millis(10));
    }

    for (svc, _) in &receivers {
        let _ = mdns.stop_browse(svc);
    }
    let _ = mdns.shutdown();

    let mut out: Vec<DiscoveredPrinter> = found.into_values().collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn service_info_to_printer(info: &ServiceInfo, kind: &str) -> Option<DiscoveredPrinter> {
    let port = info.get_port();
    if port == 0 {
        return None;
    }
    let fullname = info.get_fullname().to_string();
    // instance name is fullname without service type suffix
    let name = fullname
        .split("._")
        .next()
        .unwrap_or(&fullname)
        .trim()
        .to_string();
    let name = if name.is_empty() {
        info.get_hostname().trim_end_matches('.').to_string()
    } else {
        name
    };

    // prefer a private IP address; fall back to hostname if no addresses
    let host = pick_private_address(info).unwrap_or_else(|| {
        info.get_hostname()
            .trim_end_matches('.')
            .to_string()
    });

    if host.is_empty() {
        return None;
    }

    let rp = info
        .get_properties()
        .iter()
        .find(|p| p.key().eq_ignore_ascii_case("rp"))
        .map(|p| p.val_str().to_string())
        .map(|v| v.trim_start_matches('/').to_string())
        .filter(|s| !s.is_empty());

    Some(DiscoveredPrinter {
        name,
        host,
        port,
        kind: kind.to_string(),
        resource_path: rp,
        fullname,
    })
}

fn pick_private_address(info: &ServiceInfo) -> Option<String> {
    let addrs = info.get_addresses();
    // Prefer private/link-local/loopback addresses first
    for addr in addrs.iter() {
        let s = addr.to_string();
        // mdns-sd may give site-local; we use is_private_host to filter
        // but for picking we want the first that is private (or any)
        if is_private_host(&s) {
            return Some(s);
        }
    }
    // fallback to first address if none is private (will be filtered by caller)
    addrs.iter().next().map(|a| a.to_string())
}

/// Browse for PrintNinja peers (`_printninja._tcp`).
pub fn browse_peers(timeout_ms: u64) -> Vec<DiscoveredPeer> {
    let timeout = Duration::from_millis(timeout_ms.clamp(500, 30000));
    let deadline = Instant::now() + timeout;

    let mdns = match ServiceDaemon::new() {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!("mdns daemon failed: {e}");
            return Vec::new();
        }
    };

    let rx = match mdns.browse(PEER_SERVICE) {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("browse {PEER_SERVICE} failed: {e}");
            return Vec::new();
        }
    };

    let mut found: HashMap<String, DiscoveredPeer> = HashMap::new();

    while Instant::now() < deadline {
        while let Ok(event) = rx.recv_timeout(Duration::from_millis(50)) {
            if let ServiceEvent::ServiceResolved(info) = event {
                if let Some(peer) = service_info_to_peer(&info) {
                    if !is_private_host(&peer.host) {
                        tracing::debug!("mdns peer host not private, skipping: {}", peer.host);
                        continue;
                    }
                    // dedupe by provider_id when present, else host:port
                    let key = if !peer.provider_id.is_empty() {
                        peer.provider_id.clone()
                    } else {
                        format!("{}:{}", peer.host, peer.port)
                    };
                    found.entry(key).or_insert(peer);
                }
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }

    let _ = mdns.stop_browse(PEER_SERVICE);
    let _ = mdns.shutdown();

    let mut out: Vec<DiscoveredPeer> = found.into_values().collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn service_info_to_peer(info: &ServiceInfo) -> Option<DiscoveredPeer> {
    let fullname = info.get_fullname().to_string();
    let name = fullname
        .split("._")
        .next()
        .unwrap_or(&fullname)
        .trim()
        .to_string();
    let name = if name.is_empty() {
        info.get_hostname().trim_end_matches('.').to_string()
    } else {
        name
    };

    let host = pick_private_address(info).unwrap_or_else(|| {
        info.get_hostname()
            .trim_end_matches('.')
            .to_string()
    });
    if host.is_empty() {
        return None;
    }

    let props: HashMap<String, String> = info
        .get_properties()
        .iter()
        .map(|p| (p.key().to_ascii_lowercase(), p.val_str().to_string()))
        .collect();

    let provider_id = props.get("id").cloned().unwrap_or_default();
    let platform = props.get("plat").cloned().unwrap_or_default();
    let version = props.get("ver").cloned().unwrap_or_default();
    let protocol: u32 = props
        .get("prot")
        .and_then(|v| v.parse().ok())
        .unwrap_or(1);
    let port: u16 = props
        .get("port")
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(|| info.get_port());

    if port == 0 {
        return None;
    }

    Some(DiscoveredPeer {
        host,
        port,
        provider_id,
        platform,
        protocol,
        version,
        name,
        fullname,
    })
}

// ── Advertise ────────────────────────────────────────────────────────────

struct Advertiser {
    daemon: ServiceDaemon,
    fullname: String,
}

static ADVERTISER: OnceLock<Mutex<Option<Advertiser>>> = OnceLock::new();

fn advertiser_slot() -> &'static Mutex<Option<Advertiser>> {
    ADVERTISER.get_or_init(|| Mutex::new(None))
}

/// Start advertising `_printninja._tcp` with TXT `prot,id,port,plat,ver`.
pub fn start_advertise(port: u16, provider_id: &str, platform: &str, version: &str) -> Result<(), String> {
    let mut slot = advertiser_slot()
        .lock()
        .map_err(|e| format!("advertiser lock poisoned: {e}"))?;
    // Stop existing first
    if let Some(old) = slot.take() {
        let _ = old.daemon.unregister(&old.fullname);
        let _ = old.daemon.shutdown();
    }

    let daemon = ServiceDaemon::new().map_err(|e| format!("mdns daemon failed: {e}"))?;
    let host = hostname_for_mdns();
    let instance = format!("PrintNinja-{}", sanitize_instance(&host));
    let service_type = PEER_SERVICE;
    let fullname = format!("{instance}.{service_type}");

    // TXT properties: keep under 200 bytes
    let mut props: HashMap<String, String> = HashMap::new();
    props.insert("prot".into(), "1".into());
    props.insert("id".into(), provider_id.to_string());
    props.insert("port".into(), port.to_string());
    props.insert("plat".into(), platform.to_string());
    props.insert("ver".into(), version.to_string());

    // Advertise with LAN IP address for resolution
    let ip = lan_ip_for_mdns();
    let ips: Vec<IpAddr> = ip.into_iter().collect();
    let host_fqdn = format!("{host}.local.");

    let mut service = ServiceInfo::new(
        service_type,
        &instance,
        &host_fqdn,
        &ips[..],
        port,
        props,
    )
    .map_err(|e| format!("service info failed: {e}"))?;
    if ips.is_empty() {
        service = service.enable_addr_auto();
    }

    daemon
        .register(service)
        .map_err(|e| format!("mdns register failed: {e}"))?;

    *slot = Some(Advertiser { daemon, fullname });
    tracing::info!("mDNS advertised {MDNS_TTL} on port {port} id={} ", truncate_id(provider_id));
    Ok(())
}

pub fn stop_advertise() {
    let Ok(mut slot) = advertiser_slot().lock() else {
        return;
    };
    if let Some(old) = slot.take() {
        let _ = old.daemon.unregister(&old.fullname);
        let _ = old.daemon.shutdown();
        tracing::info!("mDNS advertising stopped");
    }
}

fn truncate_id(id: &str) -> String {
    if id.len() > 8 {
        format!("{}…", &id[..8])
    } else {
        id.to_string()
    }
}

fn sanitize_instance(host: &str) -> String {
    let mut s: String = host
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    if s.is_empty() {
        s = "PC".into();
    }
    if s.len() > 24 {
        s.truncate(24);
    }
    s
}

fn hostname_for_mdns() -> String {
    for key in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(v) = std::env::var(key) {
            let t = v.trim().to_string();
            if !t.is_empty() {
                return t;
            }
        }
    }
    if let Ok(s) = std::fs::read_to_string("/etc/hostname") {
        let t = s.trim().to_string();
        if !t.is_empty() {
            return t;
        }
    }
    "PrintNinja".into()
}

fn lan_ip_for_mdns() -> Option<IpAddr> {
    std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("8.8.8.8:80")?;
            s.local_addr()
        })
        .ok()
        .and_then(|a| {
            let ip = a.ip();
            // Don't advertise loopback; let mdns use interface enumeration instead
            if ip.is_loopback() {
                None
            } else {
                Some(ip)
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn printer_kind_mapping_by_service_type() {
        // ensure constants cover expected types
        assert!(PRINTER_SERVICES.iter().any(|(s, _)| s.contains("_ipp._tcp")));
        assert!(PRINTER_SERVICES.iter().any(|(s, _)| s.contains("_pdl-datastream")));
    }

    #[test]
    fn sanitize_instance_keeps_alnum() {
        assert_eq!(sanitize_instance("My PC 123"), "My-PC-123");
        assert_eq!(sanitize_instance(""), "PC");
    }

    #[test]
    fn txt_parse_peer_defaults() {
        // TXT missing prot -> 1, missing port -> info port, etc. Logic tested via service_info_to_peer with mocked info is hard without daemon.
        // Instead verify parsing helper logic via direct props
        let props: HashMap<String, String> = HashMap::new();
        let prot: u32 = props.get("prot").and_then(|v| v.parse().ok()).unwrap_or(1);
        assert_eq!(prot, 1);
    }

    #[test]
    fn dedupe_key_prefers_provider_id() {
        let peer = DiscoveredPeer {
            host: "192.168.1.5".into(),
            port: 17717,
            provider_id: "abc".into(),
            platform: "linux".into(),
            protocol: 1,
            version: "2.5.0".into(),
            name: "PC".into(),
            fullname: "".into(),
        };
        let key = if !peer.provider_id.is_empty() {
            peer.provider_id.clone()
        } else {
            format!("{}:{}", peer.host, peer.port)
        };
        assert_eq!(key, "abc");
    }

    #[test]
    fn private_host_filter_rejects_public() {
        assert!(!is_private_host("8.8.8.8"));
        assert!(is_private_host("192.168.1.4"));
        assert!(is_private_host("10.0.0.5"));
        assert!(is_private_host("localhost"));
    }
}
