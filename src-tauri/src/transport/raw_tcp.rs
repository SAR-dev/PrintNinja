use crate::transport::send_timeout;
use crate::transport::status;
use crate::transport::{PrinterInfo, PrinterLanguage, PrinterTransport, RawSend, RenderedJob};
use async_trait::async_trait;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// How long to wait for a raw (JetDirect) printer to accept a connection.
///
/// Kept short so an unreachable printer fails in seconds rather than after
/// the whole send budget: the OS default for an unanswered SYN is minutes.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// How long the bytes of one job may take to be accepted.
///
/// This covers only the write and flush, not the time this process spends
/// waiting for the printer's turn (that is the per-printer permit's
/// business). A raw printer sends nothing back, so this deadline is the
/// *only* thing that can end a job against a printer which accepts the
/// connection and then goes quiet.
///
/// `PRINTNINJA_SEND_TIMEOUT_SECS` overrides it (see [`send_timeout`]).
const SEND_TIMEOUT: Duration = Duration::from_secs(30);

/// How long to wait for a status query's answer.
///
/// Status replies are immediate by specification — `DLE EOT` is answered
/// even while offline or with a full buffer, TSPL says "at any time" — so
/// this is generous rather than tight. It is still bounded, because a
/// printer that never answers pays it: on the first job, and after that once
/// an hour instead of once per job (see `status::should_probe`).
const STATUS_REPLY_TIMEOUT: Duration = Duration::from_secs(3);

pub struct RawTcpPrinter {
    pub name: String,
    pub address: String,
    pub port: u16,
}

impl RawTcpPrinter {
    pub fn new(name: String, address: String) -> Self {
        // The address column may carry `host:port` (bracketed IPv6:
        // `[::1]:9292`); a bare host keeps the JetDirect default.
        let (host, port) = split_host_port(&address, 9100);
        Self {
            name,
            address: host,
            port,
        }
    }

    /// The address this printer is dialled at, formatted for `connect`.
    ///
    /// IPv6 hosts need brackets so the port is not mistaken for part of the
    /// address.
    fn socket_addr(&self) -> String {
        if self.address.contains(':') {
            format!("[{}]:{}", self.address, self.port)
        } else {
            format!("{}:{}", self.address, self.port)
        }
    }

    /// How every message about this printer names it.
    fn at(&self) -> String {
        format!("the printer at {}", self.socket_addr())
    }

    /// Open the connection, or explain why not.
    ///
    /// Shared by the status probe, the reachability probe and the job, so a
    /// printer that cannot be reached produces exactly one message, whichever
    /// of the three got there first — the probes simply get there sooner.
    async fn connect(&self) -> Result<TcpStream, String> {
        let addr = self.socket_addr();
        let at = self.at();
        match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(&addr)).await {
            Err(_) => Err(format!(
                "{at} never accepted a connection (waited {}s) — check the address and that the printer is powered on",
                CONNECT_TIMEOUT.as_secs()
            )),
            Ok(Err(e)) => Err(format!("Could not reach {at}: {e}")),
            Ok(Ok(stream)) => Ok(stream),
        }
    }

    /// Is the printer's port open?
    ///
    /// Connect and drop — nothing is written, so this cannot put anything
    /// on paper. [`PrinterTransport::test`] uses this too: a test is a
    /// connectivity check, and sending an init sequence would print a blank
    /// line on an ESC/POS printer and nothing on every other language.
    /// Also used to fail fast *before* a document is rendered for a test
    /// print.
    pub async fn reach(&self) -> Result<(), String> {
        let _stream = self.connect().await?;
        Ok(())
    }

    /// Write `data` and stop — no status question, no interpretation.
    ///
    /// [`Self::precheck`] sits in front of this in [`PrinterTransport::send`];
    /// reaching the bytes directly is for callers that only want them, such
    /// as the connectivity check.
    pub async fn send_raw(&self, data: &[u8]) -> Result<(), String> {
        // A raw printer gives no application-level reply: the job is done
        // when the bytes are written. That means a printer which accepts the
        // connection and then stops reading — a full buffer, a wedged
        // spooler, or a server answering `hang` — blocks `write_all`
        // forever. The job then sits `printing`, the UI spins and nothing
        // ever reaches history, so both phases carry a deadline.
        let at = self.at();
        let mut stream = self.connect().await?;

        let send = async {
            stream.write_all(data).await.map_err(|e| {
                format!("{at} closed the connection while the job was sending: {e}")
            })?;
            stream
                .flush()
                .await
                .map_err(|e| format!("{at} stopped responding while the job was finishing: {e}"))?;
            Ok::<(), String>(())
        };

        let deadline = send_timeout(SEND_TIMEOUT);
        tokio::time::timeout(deadline, send).await.map_err(|_| {
            format!(
                "{at} stopped responding after {}s — check for a paper jam or out-of-paper, or that it is still connected",
                deadline.as_secs()
            )
        })?
    }

    /// The raw console's send: the same bytes as [`Self::send_raw`], but the
    /// operator chooses the pacing — bytes per write, pause between writes,
    /// and the settle before the close — and every stage's wall time is
    /// recorded back through the job's [`RawSend`] so the report can show
    /// what was actually applied.
    ///
    /// An ordinary job never reaches this function: `job.raw` is `None` and
    /// the plain write above runs, byte for byte, exactly as before.
    async fn send_raw_paced(&self, data: &[u8], raw: RawSend) -> Result<(), String> {
        let delivery = raw.delivery;
        let recorder = raw.recorder;
        let at = self.at();

        let open_start = Instant::now();
        let mut stream = self.connect().await?;
        recorder.record_open(open_start.elapsed().as_millis() as u64);
        // What the operator is about to get, even if the write then fails:
        // the report stays useful on the very sends it exists to debug.
        let settle = delivery.desktop_settle_ms();
        recorder.record_effective(delivery.chunk_bytes, delivery.chunk_pause_ms, settle);

        let chunk = delivery.chunk_bytes.max(1) as usize;
        let pause = Duration::from_millis(delivery.chunk_pause_ms as u64);
        let writes = (data.len() as u64).div_ceil(delivery.chunk_bytes as u64) as u32;
        let write_start = Instant::now();

        let send = async {
            let mut pieces = data.chunks(chunk).peekable();
            while let Some(piece) = pieces.next() {
                let last = pieces.peek().is_none();
                stream.write_all(piece).await.map_err(|e| {
                    format!("{at} closed the connection while the job was sending: {e}")
                })?;
                if !last && !pause.is_zero() {
                    tokio::time::sleep(pause).await;
                }
            }
            stream
                .flush()
                .await
                .map_err(|e| format!("{at} stopped responding while the job was finishing: {e}"))?;
            Ok::<(), String>(())
        };

        // The deadline must cover the pacing the operator asked for — the
        // pauses are legitimate wall time — plus the usual allowance for a
        // write that stops being accepted.
        let deadline = send_timeout(SEND_TIMEOUT)
            + Duration::from_millis(
                (writes as u64).saturating_sub(1) * delivery.chunk_pause_ms as u64,
            );
        let write_outcome = tokio::time::timeout(deadline, send)
            .await
            .map_err(|_| {
                format!(
                    "{at} stopped responding after {}s — check for a paper jam or out-of-paper, or that it is still connected",
                    deadline.as_secs()
                )
            })?;
        write_outcome?;
        recorder.record_write(write_start.elapsed().as_millis() as u64);

        // The experiment this tool exists for: does the printer finish the
        // label if the connection lingers after the last byte?
        if settle > 0 {
            let t = Instant::now();
            tokio::time::sleep(Duration::from_millis(settle as u64)).await;
            recorder.record_settle(t.elapsed().as_millis() as u64);
        }

        let close_start = Instant::now();
        let _ = stream.shutdown().await;
        recorder.record_close(close_start.elapsed().as_millis() as u64);
        Ok(())
    }

    /// Ask the printer about itself before the job goes out, and refuse to
    /// send if it says it cannot print.
    ///
    /// This is the only place a raw print can learn anything: the printer
    /// answers a status query but never a job, so without this every
    /// device-side fault — paper out, jammed, offline — arrives looking like
    /// a successful print. Which query is asked comes from the printer's own
    /// configured language (`status::dialect_for`); a language with no query
    /// we can stand behind sends nothing and behaves exactly as it did.
    ///
    /// Two things are deliberately *not* failures, because a false failure
    /// would be a worse bug than the one this fixes:
    ///
    /// - an answer we cannot read — it answered, so it speaks the dialect,
    ///   and `decode` only claims what the bytes unmistakably say;
    /// - silence, until this printer has answered once. A printer that never
    ///   replies may simply not implement the query, and refusing every job
    ///   because of a mis-set language column would stop printing outright.
    ///
    ///   Once it *has* answered, silence is reported — which is not a
    ///   liberty: Zebra's spec says a Zebra sends no `~HS` reply at all when
    ///   media is out, the ribbon is out or the head is open, so silence is
    ///   the signal there, and ESC/POS and TSPL are specified to always
    ///   answer.
    async fn precheck(&self, language: &PrinterLanguage) -> Result<(), String> {
        let Some(dialect) = status::dialect_for(language) else {
            return Ok(());
        };
        let addr = self.socket_addr();
        if !status::should_probe(&addr, Instant::now()) {
            return Ok(());
        }

        let mut stream = self.connect().await?;
        let at = self.at();
        let query = dialect.query();
        let mut reply = Vec::new();

        let asked = tokio::time::timeout(STATUS_REPLY_TIMEOUT, async {
            stream.write_all(&query).await?;
            // Stop at a complete answer rather than at end-of-stream: the
            // printer holds the connection open until its own idle timeout.
            let mut chunk = [0u8; 256];
            while !dialect.answered(&reply) {
                match stream.read(&mut chunk).await {
                    Ok(0) => break, // hung up mid-question
                    Ok(n) => reply.extend_from_slice(&chunk[..n]),
                    Err(_) => break,
                }
            }
            Ok::<(), std::io::Error>(())
        })
        .await;

        // The connection went away under the query itself. The job's own
        // send will say that better than any status message could, so do not
        // record or report anything here.
        if matches!(asked, Ok(Err(_))) && reply.is_empty() {
            return Ok(());
        }

        if reply.is_empty() {
            let was_answering = status::had_answered(&addr);
            status::note_silent(&addr, Instant::now());
            return if was_answering {
                Err(status::silence_message(&at, STATUS_REPLY_TIMEOUT))
            } else {
                Ok(())
            };
        }

        status::note_answered(&addr);
        match status::decode(dialect, &reply) {
            Some(fault) => Err(fault.message(&at)),
            None => {
                status::note_healthy(&addr, Instant::now());
                Ok(())
            }
        }
    }
}

#[async_trait]
impl PrinterTransport for RawTcpPrinter {
    async fn discover(&self) -> Vec<PrinterInfo> {
        vec![]
    }

    async fn test(&self) -> Result<(), String> {
        // Connectivity only: the status probe needs the printer's language,
        // which this check does not receive — so no bytes go out at all.
        // Sending an init sequence would print a blank line on an ESC/POS
        // printer and nothing on every other language.
        self.reach().await
    }

    async fn send(&self, job: RenderedJob) -> Result<(), String> {
        self.precheck(&job.language).await?;
        match job.raw {
            Some(raw) => self.send_raw_paced(&job.data, raw).await,
            None => self.send_raw(&job.data).await,
        }
    }
}

/// Split `host:port` from a stored address, defaulting the port.
///
/// A bare host (`192.168.1.5`) or a bare IPv6 literal (`::1`) keeps
/// `default_port`; `host:9292` and `[::1]:9292` override it.
pub(crate) fn split_host_port(address: &str, default_port: u16) -> (String, u16) {
    // Bracketed IPv6: `[::1]:9292`.
    if let Some(rest) = address.strip_prefix('[') {
        if let Some((host, port)) = rest.split_once(']') {
            let port = port
                .strip_prefix(':')
                .and_then(|p| p.parse::<u16>().ok())
                .unwrap_or(default_port);
            return (host.to_string(), port);
        }
    }
    // Exactly one colon means `host:port`; more than one is a bare IPv6
    // literal like `::1`, whose trailing `1` must not parse as a port.
    if address.matches(':').count() == 1 {
        if let Some((host, port)) = address.rsplit_once(':') {
            if let Ok(parsed) = port.parse::<u16>() {
                return (host.to_string(), parsed);
            }
        }
    }
    (address.to_string(), default_port)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// P4 loopback tests bind a random port, so the address column must be
    /// able to carry it.
    #[test]
    fn address_may_carry_a_port() {
        assert_eq!(
            split_host_port("127.0.0.1:9292", 9100),
            ("127.0.0.1".into(), 9292)
        );
        assert_eq!(split_host_port("[::1]:9292", 9100), ("::1".into(), 9292));
    }

    #[test]
    fn a_bare_host_keeps_the_default_port() {
        assert_eq!(
            split_host_port("192.168.1.5", 9100),
            ("192.168.1.5".into(), 9100)
        );
        // Bare IPv6: the trailing component is not a port.
        assert_eq!(split_host_port("::1", 9100), ("::1".into(), 9100));
        assert_eq!(
            split_host_port("fe80::1%wlan0", 9100),
            ("fe80::1%wlan0".into(), 9100)
        );
        // A non-numeric suffix is part of the host, not a port.
        assert_eq!(
            split_host_port("labelprinter:local", 9100),
            ("labelprinter:local".into(), 9100)
        );
    }

    #[test]
    fn new_reads_the_port_from_the_address() {
        let t = RawTcpPrinter::new("T".into(), "127.0.0.1:9292".into());
        assert_eq!(t.port, 9292);
        assert_eq!(t.address, "127.0.0.1");
        let t = RawTcpPrinter::new("T".into(), "10.0.0.4".into());
        assert_eq!(t.port, 9100);
    }

    /// The probe and the job must dial the same place and be described the
    /// same way, or a failure about "the printer at …" would not be a
    /// failure about the printer the job went to.
    #[test]
    fn messages_name_the_address_the_job_uses() {
        let t = RawTcpPrinter::new("T".into(), "192.168.1.5:9292".into());
        assert_eq!(t.socket_addr(), "192.168.1.5:9292");
        assert_eq!(t.at(), "the printer at 192.168.1.5:9292");
        let t = RawTcpPrinter::new("T".into(), "::1".into());
        assert_eq!(t.socket_addr(), "[::1]:9100");
    }
}
