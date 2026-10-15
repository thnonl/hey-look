//! Adds support for the IMAP IDLE command specificed in [RFC
//! 2177](https://tools.ietf.org/html/rfc2177).

use crate::client::Session;
use crate::error::{Error, ParseError, Result};
#[cfg(feature = "tls")]
use native_tls::TlsStream;
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

/// `Handle` allows a client to block waiting for changes to the remote mailbox.
///
/// The handle blocks using the [`IDLE` command](https://tools.ietf.org/html/rfc2177#section-3)
/// specificed in [RFC 2177](https://tools.ietf.org/html/rfc2177) until the underlying server state
/// changes in some way. While idling does inform the client what changes happened on the server,
/// this implementation will currently just block until _anything_ changes, and then notify the
///
/// Note that the server MAY consider a client inactive if it has an IDLE command running, and if
/// such a server has an inactivity timeout it MAY log the client off implicitly at the end of its
/// timeout period.  Because of that, clients using IDLE are advised to terminate the IDLE and
/// re-issue it at least every 29 minutes to avoid being logged off. [`Handle::wait_keepalive`]
/// does this. This still allows a client to receive immediate mailbox updates even though it need
/// only "poll" at half hour intervals.
///
/// As long as a [`Handle`] is active, the mailbox cannot be otherwise accessed.
#[derive(Debug)]
pub struct Handle<'a, T: Read + Write> {
    session: &'a mut Session<T>,
    keepalive: Duration,
    done: bool,
}

/// The result of a wait on a [`Handle`]
#[derive(Debug, PartialEq, Eq)]
pub enum WaitOutcome {
    /// The wait timed out
    TimedOut,
    /// The mailbox was modified
    MailboxChanged,
}

/// Must be implemented for a transport in order for a `Session` using that transport to support
/// operations with timeouts.
///
/// Examples of where this is useful is for `Handle::wait_keepalive` and
/// `Handle::wait_timeout`.
pub trait SetReadTimeout {
    /// Set the timeout for subsequent reads to the given one.
    ///
    /// If `timeout` is `None`, the read timeout should be removed.
    ///
    /// See also `std::net::TcpStream::set_read_timeout`.
    fn set_read_timeout(&mut self, timeout: Option<Duration>) -> Result<()>;
}

impl<'a, T: Read + Write + 'a> Handle<'a, T> {
    pub(crate) fn make(session: &'a mut Session<T>) -> Result<Self> {
        let mut h = Handle {
            session,
            keepalive: Duration::from_secs(29 * 60),
            done: false,
        };
        if let Err(e) = h.init() {
            // Hey Look! patch: IDLE was refused (or never started), so there is nothing to end: without this the Drop below sends a
            // DONE outside IDLE, the server answers it with the tag DONE, and the tag check of read_response_onto panicked
            h.done = true;
            return Err(e);
        }
        Ok(h)
    }

    fn init(&mut self) -> Result<()> {
        // https://tools.ietf.org/html/rfc2177
        //
        // The IDLE command takes no arguments.
        self.session.run_command("IDLE")?;

        // A tagged response will be sent either
        //
        //   a) if there's an error, or
        //   b) *after* we send DONE
        let mut v = Vec::new();
        self.session.readline(&mut v)?;
        if v.starts_with(b"+") {
            self.done = false;
            return Ok(());
        }

        self.session.read_response_onto(&mut v)?;
        // We should *only* get a continuation on an error (i.e., it gives BAD or NO).
        // Hey Look! patch: a server that answers IDLE with something else (a tagged OK, garbage) is an error, not a panic
        // (the app is built with panic = "abort", so a panic here would end the whole process).
        Err(Error::Parse(ParseError::Invalid(v)))
    }

    fn terminate(&mut self) -> Result<()> {
        if !self.done {
            self.done = true;
            self.session.write_line(b"DONE")?;
            self.session.read_response().map(|_| ())
        } else {
            Ok(())
        }
    }

    /// Internal helper that doesn't consume self.
    ///
    /// This is necessary so that we can keep using the inner `Session` in `wait_keepalive`.
    fn wait_inner(&mut self, reconnect: bool) -> Result<WaitOutcome> {
        let mut v = Vec::new();
        loop {
            let result = match self.session.readline(&mut v).map(|_| ()) {
                Err(Error::Io(ref e))
                    if e.kind() == io::ErrorKind::TimedOut
                        || e.kind() == io::ErrorKind::WouldBlock =>
                {
                    if reconnect {
                        self.terminate()?;
                        self.init()?;
                        return self.wait_inner(reconnect);
                    }
                    Ok(WaitOutcome::TimedOut)
                }
                Ok(()) => Ok(WaitOutcome::MailboxChanged),
                Err(r) => Err(r),
            }?;

            // Handle Dovecot's imap_idle_notify_interval message
            if v.eq_ignore_ascii_case(b"* OK Still here\r\n") {
                v.clear();
            } else {
                break Ok(result);
            }
        }
    }

    /// Block until the selected mailbox changes.
    pub fn wait(mut self) -> Result<()> {
        self.wait_inner(true).map(|_| ())
    }
}

impl<'a, T: SetReadTimeout + Read + Write + 'a> Handle<'a, T> {
    /// Set the keep-alive interval to use when `wait_keepalive` is called.
    ///
    /// The interval defaults to 29 minutes as dictated by RFC 2177.
    pub fn set_keepalive(&mut self, interval: Duration) {
        self.keepalive = interval;
    }

    /// Block until the selected mailbox changes.
    ///
    /// This method differs from [`Handle::wait`] in that it will periodically refresh the IDLE
    /// connection, to prevent the server from timing out our connection. The keepalive interval is
    /// set to 29 minutes by default, as dictated by RFC 2177, but can be changed using
    /// [`Handle::set_keepalive`].
    ///
    /// This is the recommended method to use for waiting.
    pub fn wait_keepalive(self) -> Result<()> {
        // The server MAY consider a client inactive if it has an IDLE command
        // running, and if such a server has an inactivity timeout it MAY log
        // the client off implicitly at the end of its timeout period.  Because
        // of that, clients using IDLE are advised to terminate the IDLE and
        // re-issue it at least every 29 minutes to avoid being logged off.
        // This still allows a client to receive immediate mailbox updates even
        // though it need only "poll" at half hour intervals.
        let keepalive = self.keepalive;
        self.timed_wait(keepalive, true).map(|_| ())
    }

    /// Block until the selected mailbox changes, or until the given amount of time has expired.
    #[deprecated(note = "use wait_with_timeout instead")]
    pub fn wait_timeout(self, timeout: Duration) -> Result<()> {
        self.wait_with_timeout(timeout).map(|_| ())
    }

    /// Block until the selected mailbox changes, or until the given amount of time has expired.
    pub fn wait_with_timeout(self, timeout: Duration) -> Result<WaitOutcome> {
        self.timed_wait(timeout, false)
    }

    /// Hey Look! addition. Like `wait_with_timeout`, but the read is cut into slices of `poll`, and `stop` is asked after each one that
    /// brought nothing: when it says yes the wait ends at once (and no DONE is sent: the caller drops the connection). A thread that
    /// is blocked in a read cannot be woken from outside on Windows when the peer is silent (`shutdown` does not wake it), so this is
    /// how the app stops a push session. The read timeout is left at `finish` instead of none, so that the answer to the DONE that
    /// the drop sends cannot block for ever either. A slice that times out in the middle of a line keeps the part already read.
    pub fn wait_interruptible(
        mut self,
        timeout: Duration,
        poll: Duration,
        finish: Duration,
        stop: &dyn Fn() -> bool,
    ) -> Result<WaitOutcome> {
        let deadline = Instant::now() + timeout;
        self.session.stream.get_mut().set_read_timeout(Some(poll))?;
        let mut v = Vec::new();
        let res = loop {
            match self.session.readline(&mut v) {
                Err(Error::Io(ref e))
                    if e.kind() == io::ErrorKind::TimedOut
                        || e.kind() == io::ErrorKind::WouldBlock =>
                {
                    if stop() {
                        self.done = true;
                        break Ok(WaitOutcome::TimedOut);
                    }
                    if Instant::now() >= deadline {
                        break Ok(WaitOutcome::TimedOut);
                    }
                }
                Ok(_) => {
                    // Dovecot's imap_idle_notify_interval message
                    if v.eq_ignore_ascii_case(b"* OK Still here\r\n") {
                        v.clear();
                    } else {
                        break Ok(WaitOutcome::MailboxChanged);
                    }
                }
                Err(e) => break Err(e),
            }
        };
        let _ = self.session.stream.get_mut().set_read_timeout(Some(finish));
        res
    }

    fn timed_wait(mut self, timeout: Duration, reconnect: bool) -> Result<WaitOutcome> {
        self.session
            .stream
            .get_mut()
            .set_read_timeout(Some(timeout))?;
        let res = self.wait_inner(reconnect);
        let _ = self.session.stream.get_mut().set_read_timeout(None).is_ok();
        res
    }
}

impl<'a, T: Read + Write + 'a> Drop for Handle<'a, T> {
    fn drop(&mut self) {
        // we don't want to panic here if we can't terminate the Idle
        let _ = self.terminate().is_ok();
    }
}

impl<'a> SetReadTimeout for TcpStream {
    fn set_read_timeout(&mut self, timeout: Option<Duration>) -> Result<()> {
        TcpStream::set_read_timeout(self, timeout).map_err(Error::Io)
    }
}

#[cfg(feature = "tls")]
impl<'a> SetReadTimeout for TlsStream<TcpStream> {
    fn set_read_timeout(&mut self, timeout: Option<Duration>) -> Result<()> {
        self.get_ref().set_read_timeout(timeout).map_err(Error::Io)
    }
}
