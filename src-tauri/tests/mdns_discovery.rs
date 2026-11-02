//! Peer and printer discovery over real mDNS multicast.
//!
//! An mdns-sd daemon advertises a fake `_printninja._tcp` peer and an
//! `_ipp._tcp` printer on the host's LAN address while the library's
//! browse functions listen on the multicast group — the same
//! in-process mock pattern as the mock cupsd in `cups_discovery`.
//! Needs a private address and working mDNS multicast, so the tests
//! skip themselves when either is missing (CI runners without a LAN
//! interface stay green).

use mdns_sd::{ServiceDaemon, ServiceInfo};
use printninja_lib::api::peer_consume::is_private_host;
use printninja_lib::discovery::{browse_peers, browse_printers};
use std::collections::HashMap;
use std::net::IpAddr;

/// Serialize the two tests: both advertise on the same interface and a
/// shared mDNS socket, and `cargo test` would otherwise run them
/// concurrently.
fn lock() -> std::sync::MutexGuard<'static, ()> {
    static GUARD: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    GUARD
        .get_or_init(|| std::sync::Mutex::new(()))
        .lock()
        .unwrap()
}

/// A non-loopback private address to advertise on; None means "skip".
fn lan_ip() -> Option<IpAddr> {
    std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("8.8.8.8:80")?;
            s.local_addr()
        })
        .ok()
        .map(|a| a.ip())
        .filter(|ip| !ip.is_loopback())
        .filter(|ip| is_private_host(&ip.to_string()))
}

/// Advertise one fake peer and one fake IPP printer; dropping the
/// daemon tears both registrations down.
fn advertise_fake_lan(ip: IpAddr) -> ServiceDaemon {
    let daemon = ServiceDaemon::new().expect("mdns daemon");
    let host = "e2e-fakepc.local.";
    let ips = [ip];

    let peer = ServiceInfo::new(
        "_printninja._tcp.local.",
        "PrintNinja-E2E",
        host,
        &ips[..],
        17717,
        HashMap::from([
            ("prot".to_string(), "1".to_string()),
            ("id".to_string(), "e2epeer".to_string()),
            ("port".to_string(), "17717".to_string()),
            ("plat".to_string(), "windows".to_string()),
            ("ver".to_string(), "2.5.0".to_string()),
        ]),
    )
    .expect("peer service info");
    daemon.register(peer).expect("register peer");

    let printer = ServiceInfo::new(
        "_ipp._tcp.local.",
        "E2E-Laser",
        host,
        &ips[..],
        631,
        HashMap::from([("rp".to_string(), "/printers/laser".to_string())]),
    )
    .expect("printer service info");
    daemon.register(printer).expect("register printer");

    daemon
}

#[test]
fn browse_peers_finds_advertised_pc() {
    let _guard = lock();
    let Some(ip) = lan_ip() else {
        eprintln!("skip: no private non-loopback address to advertise on");
        return;
    };
    let lan = advertise_fake_lan(ip);
    // give the advertisement a moment to hit the multicast group
    std::thread::sleep(std::time::Duration::from_millis(500));
    let peers = browse_peers(5000);
    drop(lan);

    let peer = peers
        .iter()
        .find(|p| p.provider_id == "e2epeer")
        .unwrap_or_else(|| panic!("fake peer was advertised on {ip}, found: {peers:?}"));
    assert_eq!(peer.name, "PrintNinja-E2E");
    assert_eq!(peer.host, ip.to_string());
    assert_eq!(peer.port, 17717);
    assert_eq!(peer.platform, "windows");
    assert_eq!(peer.protocol, 1);
    assert_eq!(peer.version, "2.5.0");
}

#[test]
fn browse_printers_finds_advertised_ipp_queue() {
    let _guard = lock();
    let Some(ip) = lan_ip() else {
        eprintln!("skip: no private non-loopback address to advertise on");
        return;
    };
    let lan = advertise_fake_lan(ip);
    std::thread::sleep(std::time::Duration::from_millis(500));
    let printers = browse_printers(5000);
    drop(lan);

    let p = printers
        .iter()
        .find(|p| p.name == "E2E-Laser")
        .unwrap_or_else(|| panic!("fake printer was advertised on {ip}, found: {printers:?}"));
    assert_eq!(p.kind, "ipp");
    assert_eq!(p.host, ip.to_string());
    assert_eq!(p.port, 631);
    assert_eq!(
        p.resource_path.as_deref(),
        Some("printers/laser"),
        "rp arrives without its leading slash"
    );
}
