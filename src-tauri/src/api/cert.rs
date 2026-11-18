//! Self-signed certificate for the LAN-facing TLS listener.
//!
//! When Wi-Fi access is on, the API serves phones on `0.0.0.0:{port}`
//! over TLS so same-Wi-Fi traffic is not readable in cleartext, while the
//! PC's own UI keeps talking to a plain loopback listener (see
//! `commands::api::launch_server` and
//! docs/architecture/PHONE_AND_PC_SHARING.md#encryption).
//!
//! The certificate is self-signed and generated on first LAN launch.
//! Its subject alternative names cover the PC's current LAN IP plus
//! loopback and `localhost`, so a phone dialing the IP it probed or read
//! from the pairing screen validates without extra trust steps. The
//! cert and key are persisted under the app data directory **keyed by
//! LAN IP** and are regenerated only when the IP changes — a rotated
//! Wi-Fi address would otherwise leave the cert's SAN matching nothing
//! the phone can dial.
//!
//! Threat model, stated plainly: this stops **passive** sniffing on the
//! shared Wi-Fi. A **first-contact active** man-in-the-middle (TOFU
//! bootstrap) is not stopped — any self-signed design shares that
//! weakness — though the traffic is authenticated by per-device hashed
//! Bearer tokens either way, so the gap is confidentiality-only.

use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::ServerConfig;
use rustls_pemfile::{certs, pkcs8_private_keys};
use std::path::{Path, PathBuf};

/// How long the generated cert stays valid. Long enough that expiry
/// never happens in practice; the load path still checks it.
const VALIDITY_DAYS: i64 = 3650;

/// A loaded or freshly generated cert+key pair, as PEM text.
pub struct CertPair {
    /// The leaf certificate in PEM (`BEGIN CERTIFICATE`).
    pub cert_pem: String,
    /// The private key in PEM (PKCS#8).
    pub key_pem: String,
    /// Expiry in RFC-3339, from the meta file written at generation
    /// time. `CertificateDer` does not expose validity dates, so the
    /// load path checks this instead of parsing the cert.
    pub not_after_rfc3339: String,
}

/// File names, keyed by the LAN IP the cert's SAN covers.
fn cert_file(dir: &Path, ip: &str) -> PathBuf {
    dir.join(format!("tls-{}.crt.pem", safe_name(ip)))
}

fn key_file(dir: &Path, ip: &str) -> PathBuf {
    dir.join(format!("tls-{}.key.pem", safe_name(ip)))
}

/// The expiry timestamp written next to the cert at generation time.
fn meta_file(dir: &Path, ip: &str) -> PathBuf {
    dir.join(format!("tls-{}.meta", safe_name(ip)))
}

/// IPv6 contains `:` and can appear with a zone; keep file names boring.
fn safe_name(ip: &str) -> String {
    ip.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Load the cert for `lan_ip` from `dir`, generating and persisting a
/// fresh one when absent, corrupt, expired, or for a different IP.
///
/// `lan_ip` is the PC's current LAN address (the UDP-connect trick in
/// `commands::api::lan_ip`); it is the address phones dial, so it must
/// be in the SAN for their validation to succeed.
pub fn ensure_cert(dir: &Path, lan_ip: &str) -> Result<CertPair, String> {
    if let Some(pair) = load_cert(dir, lan_ip) {
        return Ok(pair);
    }
    generate_and_store(dir, lan_ip)
}

/// Try to load and validate a stored cert for `lan_ip`; `None` means
/// "generate a new one".
fn load_cert(dir: &Path, lan_ip: &str) -> Option<CertPair> {
    let cert_bytes = std::fs::read(cert_file(dir, lan_ip)).ok()?;
    let key_bytes = std::fs::read(key_file(dir, lan_ip)).ok()?;
    let cert_pem = String::from_utf8(cert_bytes).ok()?;
    let key_pem = String::from_utf8(key_bytes).ok()?;

    // Must parse as exactly one cert and one key.
    let certs: Vec<CertificateDer<'_>> = certs(&mut cert_pem.as_bytes())
        .collect::<Result<_, _>>()
        .ok()?;
    if certs.len() != 1 {
        return None;
    }
    // `pkcs8_private_keys` yields only PKCS#8 keys — the format rcgen
    // emits — so a non-PKCS#8 or absent key means the file is not ours.
    let keys: Vec<PrivatePkcs8KeyDer<'_>> = pkcs8_private_keys(&mut key_pem.as_bytes())
        .collect::<Result<_, _>>()
        .ok()?;
    if keys.len() != 1 {
        return None;
    }
    // Not expired, per the meta file written at generation time.
    let not_after_meta = std::fs::read_to_string(meta_file(dir, lan_ip)).ok()?;
    let not_after = chrono::DateTime::parse_from_rfc3339(not_after_meta.trim())
        .ok()?
        .with_timezone(&chrono::Utc);
    if chrono::Utc::now() >= not_after {
        return None;
    }
    Some(CertPair {
        cert_pem,
        key_pem,
        not_after_rfc3339: not_after_meta.trim().to_string(),
    })
}

fn generate_and_store(dir: &Path, lan_ip: &str) -> Result<CertPair, String> {
    let pair = generate(lan_ip)?;
    let tls_dir = dir.join("tls");
    std::fs::create_dir_all(&tls_dir).map_err(|e| format!("cannot create cert directory: {e}"))?;
    // Write key before cert: a crash in between leaves "no cert"
    // (which regenerates) rather than "cert without key".
    std::fs::write(meta_file(dir, lan_ip), &pair.not_after_rfc3339)
        .map_err(|e| format!("cannot write cert expiry: {e}"))?;
    std::fs::write(key_file(dir, lan_ip), &pair.key_pem)
        .map_err(|e| format!("cannot write cert key: {e}"))?;
    std::fs::write(cert_file(dir, lan_ip), &pair.cert_pem)
        .map_err(|e| format!("cannot write certificate: {e}"))?;
    Ok(pair)
}

/// Build the self-signed cert for the given LAN IP. Pure: no filesystem,
/// so tests can call it directly.
fn generate(lan_ip: &str) -> Result<CertPair, String> {
    use rcgen::{CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, KeyPair, SanType};

    let key_pair = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256)
        .map_err(|e| format!("cannot generate cert key: {e}"))?;

    let mut params = CertificateParams::new(vec![
        "PrintNinja".to_string(),
        format!("printninja {lan_ip}"),
    ])
    .map_err(|e| format!("bad certificate subject: {e}"))?;
    params
        .distinguished_name
        .push(DnType::CommonName, "PrintNinja".to_string());
    params.is_ca = IsCa::NoCa;
    params
        .extended_key_usages
        .push(ExtendedKeyUsagePurpose::ServerAuth);
    let not_before = chrono::Utc::now();
    let not_after = not_before + chrono::Duration::days(VALIDITY_DAYS);
    // rcgen takes `time` crate offsets; chrono is what the meta file and
    // the load path use, so convert at the boundary.
    let to_time = |t: chrono::DateTime<chrono::Utc>| -> Result<time::OffsetDateTime, String> {
        time::OffsetDateTime::from_unix_timestamp(t.timestamp())
            .map_err(|e| format!("bad certificate time: {e}"))
    };
    params.not_before = to_time(not_before)?;
    params.not_after = to_time(not_after)?;
    // SAN: the LAN IP phones dial, plus loopback and the local name so
    // the cert is also usable by anything on the box itself.
    params.subject_alt_names = {
        let mut sans: Vec<SanType> = Vec::new();
        match lan_ip.parse::<std::net::IpAddr>() {
            Ok(ip) => sans.push(SanType::IpAddress(ip)),
            Err(_) => sans.push(SanType::DnsName(
                rcgen::Ia5String::try_from(lan_ip.to_string())
                    .map_err(|e| format!("bad LAN address for cert: {e}"))?,
            )),
        }
        sans.push(SanType::IpAddress(std::net::IpAddr::V4(
            std::net::Ipv4Addr::LOCALHOST,
        )));
        sans.push(SanType::IpAddress(std::net::IpAddr::V6(
            std::net::Ipv6Addr::LOCALHOST,
        )));
        sans.push(SanType::DnsName(
            rcgen::Ia5String::try_from("localhost".to_string())
                .map_err(|e| format!("bad LAN address for cert: {e}"))?,
        ));
        sans
    };

    let cert = params
        .self_signed(&key_pair)
        .map_err(|e| format!("cannot sign certificate: {e}"))?;
    let cert_pem = cert.pem();
    let key_pem = key_pair.serialize_pem();
    Ok(CertPair {
        cert_pem,
        key_pem,
        not_after_rfc3339: not_after.to_rfc3339(),
    })
}

/// Build a rustls `ServerConfig` from a loaded pair. `axum-server`'s
/// `RustlsConfig::from_config` takes ownership of this.
pub fn server_config(pair: &CertPair) -> Result<ServerConfig, String> {
    let certs: Vec<CertificateDer<'_>> = certs(&mut pair.cert_pem.as_bytes())
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let keys: Vec<PrivatePkcs8KeyDer<'_>> = pkcs8_private_keys(&mut pair.key_pem.as_bytes())
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let key = keys
        .into_iter()
        .next()
        .map(PrivateKeyDer::from)
        .ok_or("cert key missing")?;
    let mut config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| format!("cannot build TLS config: {e}"))?;
    // The phones speak HTTP/1.1; without ALPN rustls offers none and some
    // clients refuse the handshake.
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pn-cert-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn generates_a_valid_cert_for_the_lan_ip() {
        let pair = generate("192.168.1.4").expect("generate");
        assert!(pair.cert_pem.contains("BEGIN CERTIFICATE"));
        assert!(pair.key_pem.contains("BEGIN PRIVATE KEY"));
        // PKCS#8 (rcgen's output), not PKCS#1.
        assert!(!pair.key_pem.contains("BEGIN RSA PRIVATE KEY"));
        // Exactly one cert, and the recorded expiry is parseable and
        // far in the future.
        let parsed: Vec<CertificateDer<'_>> = certs(&mut pair.cert_pem.as_bytes())
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(parsed.len(), 1);
        let not_after =
            chrono::DateTime::parse_from_rfc3339(&pair.not_after_rfc3339).expect("rfc3339");
        assert!(
            not_after > chrono::Utc::now(),
            "expiry must be in the future"
        );
    }

    #[test]
    fn ensure_cert_is_stable_across_loads() {
        let dir = temp_dir("stable");
        let first = ensure_cert(&dir, "192.168.1.4").expect("first");
        let second = ensure_cert(&dir, "192.168.1.4").expect("second");
        assert_eq!(first.cert_pem, second.cert_pem, "same IP reloads");
        assert_eq!(first.key_pem, second.key_pem);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_different_lan_ip_regenerates() {
        let dir = temp_dir("regen");
        let first = ensure_cert(&dir, "192.168.1.4").expect("first");
        let second = ensure_cert(&dir, "10.0.0.9").expect("second");
        assert_ne!(first.cert_pem, second.cert_pem, "new IP needs a new SAN");
        // The old file survives: the PC may move back to that network.
        assert!(cert_file(&dir, "192.168.1.4").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_file_regenerates() {
        let dir = temp_dir("corrupt");
        let first = ensure_cert(&dir, "192.168.1.4").expect("first");
        std::fs::write(cert_file(&dir, "192.168.1.4"), b"not a cert").expect("corrupt");
        let second = ensure_cert(&dir, "192.168.1.4").expect("second");
        assert_ne!(first.cert_pem, second.cert_pem, "corrupt file is replaced");
        // The replacement must be usable, not just different.
        assert!(server_config(&second).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_expired_meta_regenerates() {
        let dir = temp_dir("expired");
        let first = ensure_cert(&dir, "192.168.1.4").expect("first");
        std::fs::write(meta_file(&dir, "192.168.1.4"), "2020-01-01T00:00:00Z").expect("expire");
        let second = ensure_cert(&dir, "192.168.1.4").expect("second");
        assert_ne!(first.cert_pem, second.cert_pem, "expired cert is replaced");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn server_config_accepts_the_generated_pair() {
        let pair = generate("192.168.1.4").expect("generate");
        let config = server_config(&pair).expect("config");
        assert_eq!(
            config.alpn_protocols,
            vec![b"http/1.1".to_vec()],
            "HTTP/1.1 must be offered to the phones"
        );
    }
}
