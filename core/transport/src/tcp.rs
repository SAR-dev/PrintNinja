//! Raw TCP / JetDirect (port 9100): the network transport.

use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};

use crate::{SendError, SendPlan, Transport, UnitReport};

/// A printer reached over raw TCP (JetDirect / network port 9100).
#[derive(Debug)]
pub struct TcpTransport {
    stream: TcpStream,
}

impl TcpTransport {
    /// Connect to `host:port`, giving up after `deadline`.
    pub fn connect(host: &str, port: u16, deadline: Duration) -> Result<Self, SendError> {
        let addr: SocketAddr = format!("{host}:{port}")
            .parse()
            .map_err(|e| SendError::Connect(format!("invalid address: {e}")))?;
        let stream = TcpStream::connect_timeout(&addr, deadline)
            .map_err(|e| SendError::Connect(e.to_string()))?;
        // Paced writes must not be reassembled by Nagle: the profile's
        // chunk + pause *is* the pacing, and the app-level delay already
        // spaces the segments.
        let _ = stream.set_nodelay(true);
        Ok(TcpTransport { stream })
    }
}

impl Transport for TcpTransport {
    fn send_unit(&mut self, data: &[u8], plan: &SendPlan) -> UnitReport {
        // Each write gets the full send budget; a stall that outlives it
        // means the peer is not reading (plan §5.6).
        if self.stream.set_write_timeout(Some(plan.send)).is_err() {
            return UnitReport {
                bytes_written: 0,
                error: Some(SendError::Io("could not set write timeout".to_string())),
            };
        }
        let mut written = 0u64;
        let mut pos = 0usize;
        while pos < data.len() {
            let end = (pos + plan.chunk_bytes as usize).min(data.len());
            let chunk = &data[pos..end];
            match self.stream.write(chunk) {
                Ok(0) => {
                    return UnitReport {
                        bytes_written: written,
                        error: Some(SendError::ClosedByPeer),
                    };
                }
                Ok(n) => {
                    written += n as u64;
                    pos += n;
                    if pos < data.len() && plan.pause_ms > 0 {
                        std::thread::sleep(Duration::from_millis(plan.pause_ms as u64));
                    }
                }
                // A write timeout surfaces as `TimedOut` on Windows but as
                // `WouldBlock` (EWOULDBLOCK) on Linux; either way the send
                // budget ran out, which is exactly `SendDeadline`.
                Err(e) if e.kind() == ErrorKind::TimedOut || e.kind() == ErrorKind::WouldBlock => {
                    return UnitReport {
                        bytes_written: written,
                        error: Some(SendError::SendDeadline),
                    };
                }
                // The peer went away: `ConnectionAborted`/`ConnectionReset`
                // on Windows, `BrokenPipe` (EPIPE) on Linux.
                Err(e)
                    if e.kind() == ErrorKind::ConnectionAborted
                        || e.kind() == ErrorKind::ConnectionReset
                        || e.kind() == ErrorKind::BrokenPipe =>
                {
                    return UnitReport {
                        bytes_written: written,
                        error: Some(SendError::ClosedByPeer),
                    };
                }
                Err(e) => {
                    return UnitReport {
                        bytes_written: written,
                        error: Some(SendError::Io(e.to_string())),
                    };
                }
            }
        }
        UnitReport::ok(data.len() as u64)
    }

    fn status_reply(
        &mut self,
        query: &[u8],
        deadline: Duration,
        complete: &dyn Fn(&[u8]) -> bool,
    ) -> Result<Option<Vec<u8>>, SendError> {
        self.stream
            .set_write_timeout(Some(deadline))
            .map_err(|e| SendError::Io(e.to_string()))?;
        if let Err(e) = self.stream.write_all(query) {
            // A write deadline is `TimedOut` on Windows, `WouldBlock` on
            // Linux (see `send_unit`); only a genuine peer failure is
            // `ClosedByPeer`.
            let err = if matches!(e.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) {
                SendError::SendDeadline
            } else {
                SendError::ClosedByPeer
            };
            return Err(err);
        }
        // Absolute read deadline: each read gets the *remaining* budget,
        // so a chatty but incomplete reply cannot stretch past `deadline`.
        let end = Instant::now() + deadline;
        let mut out = Vec::new();
        let mut buf = [0u8; 512];
        loop {
            let remaining = end.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            self.stream
                .set_read_timeout(Some(remaining))
                .map_err(|e| SendError::Io(e.to_string()))?;
            match self.stream.read(&mut buf) {
                Ok(0) => break, // the peer closed the connection
                Ok(n) => {
                    out.extend_from_slice(&buf[..n]);
                    if complete(&out) {
                        break;
                    }
                }
                // Read deadline: `TimedOut` on Windows, `WouldBlock` on
                // Linux. Silence is an answer, not a failure.
                Err(e) if e.kind() == ErrorKind::TimedOut || e.kind() == ErrorKind::WouldBlock => {
                    break
                }
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                Err(e) => return Err(SendError::Io(e.to_string())),
            }
        }
        let _ = self.stream.set_read_timeout(None);
        let _ = self.stream.set_write_timeout(None);
        Ok(if out.is_empty() { None } else { Some(out) })
    }

    fn finish(&mut self, plan: &SendPlan) {
        if plan.close_delay_ms > 0 {
            std::thread::sleep(Duration::from_millis(plan.close_delay_ms as u64));
        }
        // Shutting down the stream is enough; drop would close it too, but
        // the transport object outlives the connection from the job's
        // point of view.
        let _ = self.stream.shutdown(std::net::Shutdown::Both);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn connect(port: u16) -> TcpTransport {
        TcpTransport::connect("127.0.0.1", port, Duration::from_secs(2)).unwrap()
    }

    #[test]
    fn connect_to_closed_port_is_connect_error() {
        // Take a port, give it back, connect to the hole.
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let p = l.local_addr().unwrap().port();
        drop(l);
        let err = TcpTransport::connect("127.0.0.1", p, Duration::from_secs(2)).unwrap_err();
        assert!(matches!(err, SendError::Connect(_)), "{err}");
        assert!(err.retryable());
    }

    #[test]
    fn send_unit_delivers_everything_paced() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let p = l.local_addr().unwrap().port();
        // Connect first, then accept: the backlog completes the handshake,
        // so accept returns at once (an accept before the connect would
        // deadlock this test).
        let mut t = connect(p);
        let mut server = l.accept().unwrap().0;

        let plan = SendPlan {
            chunk_bytes: 1024,
            pause_ms: 50,
            close_delay_ms: 0,
            ..SendPlan::default()
        };
        // 3000 bytes -> 3 chunks -> 2 pauses of 50 ms.
        let data: Vec<u8> = (0..3000u32).map(|i| (i % 251) as u8).collect();
        let start = Instant::now();
        let report = t.send_unit(&data, &plan);
        let elapsed = start.elapsed();
        assert_eq!(report, UnitReport::ok(3000));
        assert!(
            elapsed >= Duration::from_millis(90),
            "pacing not applied: {elapsed:?}"
        );
        let mut got = [0u8; 3000];
        server.read_exact(&mut got).unwrap();
        assert_eq!(got, data.as_slice());
    }

    #[test]
    fn peer_closing_is_closed_by_peer() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let p = l.local_addr().unwrap().port();
        // Connect, accept, then drop the peer: it is gone before the
        // first write.
        let mut t = connect(p);
        let server = l.accept().unwrap().0;
        drop(server);
        // Enough data that the write cannot all land in the send buffer
        // before the reset arrives.
        let data = vec![0u8; 4 * 1024 * 1024];
        let report = t.send_unit(&data, &SendPlan::default());
        assert!(report.error.is_some());
        assert_eq!(
            report.error.unwrap(),
            SendError::ClosedByPeer,
            "expected ClosedByPeer after the peer went away"
        );
    }

    #[test]
    fn stalled_write_hits_send_deadline() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let p = l.local_addr().unwrap().port();
        let mut t = connect(p);
        let server = l.accept().unwrap().0;
        // Keep the server socket open but never read.
        std::mem::forget(server);
        let plan = SendPlan {
            chunk_bytes: 1024,
            pause_ms: 0,
            send: Duration::from_secs(1),
            ..SendPlan::default()
        };
        let data = vec![0u8; 8 * 1024 * 1024];
        let start = Instant::now();
        let report = t.send_unit(&data, &plan);
        assert_eq!(report.error.unwrap(), SendError::SendDeadline);
        // How many bytes the kernel accepted before the deadline is
        // platform-dependent (loopback send buffers); the contract is
        // that the deadline stopped the write mid-unit.
        assert!(
            report.bytes_written < data.len() as u64,
            "the whole unit went out despite the stall: {} bytes",
            report.bytes_written
        );
        assert!(start.elapsed() >= Duration::from_millis(900));
    }

    #[test]
    fn status_reply_silence_is_none_not_error() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let p = l.local_addr().unwrap().port();
        let mut t = connect(p);
        let server = l.accept().unwrap().0;
        // The server reads the query and closes without answering.
        let handle = std::thread::spawn(move || {
            let mut server = server;
            let mut buf = [0u8; 64];
            let _ = server.read(&mut buf);
            drop(server);
        });
        let reply = t
            .status_reply(b"~HS", Duration::from_secs(2), &|_| true)
            .unwrap();
        assert_eq!(reply, None);
        handle.join().unwrap();
    }

    #[test]
    fn status_reply_reads_until_complete() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let p = l.local_addr().unwrap().port();
        let mut t = connect(p);
        let server = l.accept().unwrap().0;
        let handle = std::thread::spawn(move || {
            let mut server = server;
            let mut buf = [0u8; 64];
            let _ = server.read(&mut buf);
            // Answer in two fragments with a gap: the transport must
            // accumulate until `complete` says stop.
            server.write_all(&[0x12, 0x12]).unwrap();
            std::thread::sleep(Duration::from_millis(80));
            server.write_all(&[0x12, 0x12]).unwrap();
        });
        let reply = t
            .status_reply(b"DLE EOT", Duration::from_secs(2), &|r| r.len() >= 4)
            .unwrap();
        assert_eq!(reply, Some(vec![0x12; 4]));
        handle.join().unwrap();
    }
}
