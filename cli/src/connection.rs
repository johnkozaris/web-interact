use std::io::{self, BufRead, Write};

use crate::paths;

#[cfg(unix)]
use std::os::unix::net::UnixStream;
#[cfg(unix)]
use std::path::PathBuf;
#[cfg(unix)]
use std::time::Duration;

#[cfg(windows)]
use interprocess::local_socket::{prelude::*, GenericNamespaced, Stream};

#[cfg(unix)]
pub type DaemonStream = UnixStream;
#[cfg(windows)]
pub type DaemonStream = Stream;

#[cfg(unix)]
pub fn socket_path() -> io::Result<PathBuf> {
    paths::daemon_socket_path()
}

#[cfg(unix)]
pub fn connect_to_daemon() -> io::Result<DaemonStream> {
    let stream = DaemonStream::connect(socket_path()?)?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    Ok(stream)
}

#[cfg(windows)]
pub fn connect_to_daemon() -> io::Result<DaemonStream> {
    let name = paths::daemon_pipe_name()?
        .to_ns_name::<GenericNamespaced>()
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;

    DaemonStream::connect(name)
}

pub fn send_message<W: Write>(stream: &mut W, msg: &serde_json::Value) -> io::Result<()> {
    let json = serde_json::to_string(msg)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    stream.write_all(json.as_bytes())?;
    stream.write_all(b"\n")?;
    stream.flush()
}

pub fn read_line<R: BufRead>(reader: &mut R) -> io::Result<String> {
    let mut line = String::new();
    let bytes_read = reader.read_line(&mut line)?;

    if bytes_read == 0 {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "Daemon connection closed unexpectedly",
        ));
    }

    Ok(line)
}
