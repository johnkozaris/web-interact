use std::env;
use std::io;
use std::path::PathBuf;

pub const WEB_INTERACT_HOME_ENV: &str = "WEB_INTERACT_HOME";

fn configured_base_dir() -> io::Result<Option<PathBuf>> {
    match env::var_os(WEB_INTERACT_HOME_ENV) {
        Some(value) => {
            let path = PathBuf::from(value);
            if path.as_os_str().is_empty() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!(
                        "`{WEB_INTERACT_HOME_ENV}` is set but empty. Set it to an absolute path or unset it."
                    ),
                ));
            }

            if !path.is_absolute() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!(
                        "`{WEB_INTERACT_HOME_ENV}` must be an absolute path. Got: {}",
                        path.display()
                    ),
                ));
            }

            Ok(Some(path))
        }
        None => Ok(None),
    }
}

pub fn web_interact_base_dir() -> io::Result<PathBuf> {
    if let Some(path) = configured_base_dir()? {
        return Ok(path);
    }

    dirs::home_dir().map(|path| path.join(".web-interact")).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "Could not determine the home directory. Set `{WEB_INTERACT_HOME_ENV}` to an absolute path."
            ),
        )
    })
}

pub fn daemon_pid_path() -> io::Result<PathBuf> {
    Ok(web_interact_base_dir()?.join("daemon.pid"))
}

#[cfg(unix)]
pub fn daemon_socket_path() -> io::Result<PathBuf> {
    Ok(web_interact_base_dir()?.join("daemon.sock"))
}

#[cfg(windows)]
fn sanitize_pipe_segment(value: &str) -> String {
    let mut sanitized = String::new();
    let mut previous_was_dash = false;

    for character in value.chars() {
        let keep = matches!(character, 'a'..='z' | 'A'..='Z' | '0'..='9' | '.' | '_' | '-');
        if keep {
            sanitized.push(character.to_ascii_lowercase());
            previous_was_dash = false;
            continue;
        }

        if !previous_was_dash {
            sanitized.push('-');
            previous_was_dash = true;
        }
    }

    let sanitized = sanitized.trim_matches('-').to_string();
    let shortened = if sanitized.len() > 80 {
        sanitized[sanitized.len() - 80..].to_string()
    } else {
        sanitized
    };

    if shortened.is_empty() {
        "web-interact".to_string()
    } else {
        shortened
    }
}

#[cfg(windows)]
pub fn daemon_pipe_name() -> io::Result<String> {
    let base_dir = web_interact_base_dir()?;
    Ok(format!(
        "web-interact-daemon-{}",
        sanitize_pipe_segment(&base_dir.to_string_lossy())
    ))
}
