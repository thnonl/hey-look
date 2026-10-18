//! Helpers shared by the unit tests of several modules.

/// An address that refuses every connection, on every system, however many other tests run beside this one.
///
/// A test that needs "nothing listens here" used to bind `127.0.0.1:0`, read the port and drop the listener. The port is free again at
/// once, and another test of the same `cargo test` process (every fake server binds port 0 too) can be given it: then the "dead" address
/// answers. Port 1 is outside every ephemeral range, and no test binds it (binding it needs administrator rights on Linux and macOS, and the
/// tests bind port 0 only), so a connect is refused every time.
pub fn dead_addr() -> std::net::SocketAddr {
    std::net::SocketAddr::from(([127, 0, 0, 1], 1))
}

#[cfg(test)]
mod tests {
    use super::dead_addr;

    #[test]
    fn the_dead_address_refuses_a_connection() {
        let e = std::net::TcpStream::connect_timeout(&dead_addr(), std::time::Duration::from_secs(10)).unwrap_err();
        assert!(!matches!(e.kind(), std::io::ErrorKind::TimedOut), "refused, not silent: {e}");
    }
}
