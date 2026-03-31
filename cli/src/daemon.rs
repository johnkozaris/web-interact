use crate::connection::connect_to_daemon;
use crate::paths::{daemon_pid_path, web_interact_base_dir};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::env;
use std::error::Error;
use std::ffi::OsStr;
use std::fs;
use std::io;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const EMBEDDED_DAEMON: &str = include_str!("../../daemon/dist/daemon.bundle.mjs");
const EMBEDDED_SANDBOX_CLIENT: &str = include_str!("../../daemon/dist/sandbox-client.js");
const EMBEDDED_PACKAGE_JSON: &str = r#"{
  "name": "web-interact-runtime",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.33.0",
  "dependencies": {
    "patchright": "1.59.1",
    "patchright-core": "1.59.1",
    "quickjs-emscripten": "0.32.0"
  }
}"#;

#[derive(Deserialize)]
struct EmbeddedRuntimeManifest {
    dependencies: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct InstalledPackageManifest {
    version: String,
}

struct PackageManagerCommand {
    program: &'static str,
    prefix_args: &'static [&'static str],
    display_name: &'static str,
}

#[derive(Debug)]
enum InstallCommandError {
    NotFound,
    Failed(String),
}

impl std::fmt::Display for InstallCommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => write!(f, "required package manager command was not found in PATH"),
            Self::Failed(message) => write!(f, "{message}"),
        }
    }
}

impl Error for InstallCommandError {}

#[cfg(target_os = "windows")]
const PACKAGE_MANAGER_CANDIDATES: [PackageManagerCommand; 2] = [
    PackageManagerCommand {
        program: "pnpm.cmd",
        prefix_args: &[],
        display_name: "pnpm",
    },
    PackageManagerCommand {
        program: "corepack.cmd",
        prefix_args: &["pnpm"],
        display_name: "corepack pnpm",
    },
];

#[cfg(not(target_os = "windows"))]
const PACKAGE_MANAGER_CANDIDATES: [PackageManagerCommand; 2] = [
    PackageManagerCommand {
        program: "pnpm",
        prefix_args: &[],
        display_name: "pnpm",
    },
    PackageManagerCommand {
        program: "corepack",
        prefix_args: &["pnpm"],
        display_name: "corepack pnpm",
    },
];

struct DaemonCommand {
    program: String,
    args: Vec<String>,
    current_dir: PathBuf,
    requires_runtime_install: bool,
}

pub fn ensure_daemon() -> Result<(), Box<dyn Error>> {
    if is_daemon_running() {
        return Ok(());
    }

    let command = find_daemon_command()?;
    if command.requires_runtime_install && !embedded_runtime_installed(&command.current_dir) {
        eprintln!("Installing web-interact runtime (first run)...");
        install_daemon_runtime()?;
    }

    spawn_daemon(&command)?;

    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        thread::sleep(Duration::from_millis(100));
        if is_daemon_running() {
            return Ok(());
        }
    }

    Err("Daemon failed to start within 5 seconds".into())
}

pub fn ensure_daemon_extracted() -> Result<PathBuf, Box<dyn Error>> {
    let base_dir = daemon_base_dir()?;
    let daemon_path = base_dir.join("daemon.mjs");
    let package_json_path = base_dir.join("package.json");

    fs::create_dir_all(&base_dir)?;
    let sandbox_client_path = base_dir.join("sandbox-client.js");
    sync_text_file(&daemon_path, EMBEDDED_DAEMON)?;
    sync_text_file(&sandbox_client_path, EMBEDDED_SANDBOX_CLIENT)?;
    sync_text_file(&package_json_path, EMBEDDED_PACKAGE_JSON)?;

    Ok(daemon_path)
}

pub fn install_daemon_runtime() -> Result<(), Box<dyn Error>> {
    let base_dir = daemon_base_dir()?;
    ensure_daemon_extracted()?;
    run_package_manager_command(&["install", "--ignore-scripts"], &base_dir)?;
    run_package_manager_command(&["exec", "patchright", "install", "chromium"], &base_dir)?;
    Ok(())
}

pub fn is_daemon_running() -> bool {
    connect_to_daemon().is_ok()
}

pub fn current_daemon_pid() -> Option<i32> {
    daemon_pid()
}

pub fn wait_for_daemon_exit(pid: i32, timeout: Duration) -> Result<(), Box<dyn Error>> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if daemon_has_exited(pid, connect_to_daemon().is_err()) {
            return Ok(());
        }

        thread::sleep(Duration::from_millis(100));
    }

    Err(format!("Daemon failed to stop within {} seconds", timeout.as_secs()).into())
}

fn daemon_has_exited(_pid: i32, daemon_unreachable: bool) -> bool {
    daemon_unreachable
}

fn spawn_daemon(command: &DaemonCommand) -> io::Result<()> {
    let mut process = Command::new(&command.program);
    process.args(&command.args);
    process.current_dir(&command.current_dir);
    process.stdin(Stdio::null());
    process.stdout(Stdio::null());
    process.stderr(Stdio::null());

    #[cfg(unix)]
    unsafe {
        process.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let _child = process.spawn()?;
    Ok(())
}

fn daemon_pid() -> Option<i32> {
    let pid_path = daemon_pid_path().ok()?;
    let pid = fs::read_to_string(pid_path).ok()?;
    pid.trim().parse::<i32>().ok()
}

fn find_daemon_command() -> Result<DaemonCommand, Box<dyn Error>> {
    if let Some(entry) = env::var_os("WEB_INTERACT_DAEMON") {
        return command_from_entry(PathBuf::from(entry));
    }

    let daemon_path = ensure_daemon_extracted()?;
    Ok(DaemonCommand {
        program: "node".to_string(),
        args: vec![daemon_path.to_string_lossy().into_owned()],
        current_dir: daemon_base_dir()?,
        requires_runtime_install: true,
    })
}

fn command_from_entry(entry: PathBuf) -> Result<DaemonCommand, Box<dyn Error>> {
    let entry = fs::canonicalize(entry)?;
    let current_dir = entry
        .parent()
        .ok_or("Daemon entrypoint has no parent directory")?
        .to_path_buf();

    match entry.extension().and_then(OsStr::to_str) {
        Some("js") | Some("mjs") | Some("cjs") => Ok(DaemonCommand {
            program: "node".to_string(),
            args: vec![entry.to_string_lossy().into_owned()],
            current_dir,
            requires_runtime_install: false,
        }),
        Some("ts") | Some("mts") | Some("cts") => {
            let tsx_cli = find_tsx_cli(&entry)?;
            Ok(DaemonCommand {
                program: "node".to_string(),
                args: vec![
                    tsx_cli.to_string_lossy().into_owned(),
                    entry.to_string_lossy().into_owned(),
                ],
                current_dir,
                requires_runtime_install: false,
            })
        }
        _ => Ok(DaemonCommand {
            program: entry.to_string_lossy().into_owned(),
            args: Vec::new(),
            current_dir,
            requires_runtime_install: false,
        }),
    }
}

fn find_tsx_cli(entry: &Path) -> Result<PathBuf, Box<dyn Error>> {
    for candidate in entry.ancestors() {
        let tsx_cli = candidate
            .join("node_modules")
            .join("tsx")
            .join("dist")
            .join("cli.mjs");
        if tsx_cli.is_file() {
            return Ok(tsx_cli);
        }
    }

    Err("Could not locate the tsx runtime required to launch the TypeScript daemon.".into())
}

fn daemon_base_dir() -> Result<PathBuf, Box<dyn Error>> {
    Ok(web_interact_base_dir()?)
}

fn embedded_runtime_installed(base_dir: &Path) -> bool {
    embedded_runtime_dependencies()
        .map(|dependencies| {
            dependencies
                .iter()
                .all(|(package_name, expected_version)| {
                    dependency_installed(base_dir, package_name, expected_version)
                })
        })
        .unwrap_or(false)
}

fn embedded_runtime_dependencies() -> Option<BTreeMap<String, String>> {
    serde_json::from_str::<EmbeddedRuntimeManifest>(EMBEDDED_PACKAGE_JSON)
        .ok()
        .map(|manifest| manifest.dependencies)
}

fn dependency_installed(base_dir: &Path, package_name: &str, expected_version: &str) -> bool {
    let manifest_path = base_dir
        .join("node_modules")
        .join(package_name)
        .join("package.json");
    let manifest = match fs::read_to_string(manifest_path) {
        Ok(manifest) => manifest,
        Err(_) => return false,
    };

    let installed_manifest = match serde_json::from_str::<InstalledPackageManifest>(&manifest) {
        Ok(installed_manifest) => installed_manifest,
        Err(_) => return false,
    };

    installed_manifest.version == expected_version
}

fn run_package_manager_command(args: &[&str], current_dir: &Path) -> Result<(), Box<dyn Error>> {
    for command in &PACKAGE_MANAGER_CANDIDATES {
        match run_install_command(command, args, current_dir) {
            Ok(()) => return Ok(()),
            Err(InstallCommandError::NotFound) => continue,
            Err(InstallCommandError::Failed(message)) => return Err(message.into()),
        }
    }

    Err(format!(
        "Could not find `pnpm` or `corepack` in PATH while setting up the embedded daemon runtime in {}. Install pnpm 10 or enable Corepack and run `web-interact install` again.",
        current_dir.display()
    )
    .into())
}

fn format_command_label(command: &PackageManagerCommand, args: &[&str]) -> String {
    if args.is_empty() {
        command.display_name.to_string()
    } else {
        format!("{} {}", command.display_name, args.join(" "))
    }
}

fn sync_text_file(path: &Path, contents: &str) -> Result<(), Box<dyn Error>> {
    let needs_update = match fs::read_to_string(path) {
        Ok(existing) => existing != contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => true,
        Err(error) => return Err(error.into()),
    };

    if needs_update {
        fs::write(path, contents)?;
    }

    Ok(())
}

fn run_install_command(
    command: &PackageManagerCommand,
    args: &[&str],
    current_dir: &Path,
) -> Result<(), InstallCommandError> {
    let full_args = command
        .prefix_args
        .iter()
        .copied()
        .chain(args.iter().copied())
        .collect::<Vec<_>>();
    let command_label = format_command_label(command, args);
    let status = Command::new(command.program)
        .args(&full_args)
        .current_dir(current_dir)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(|error| match error.kind() {
            io::ErrorKind::NotFound => InstallCommandError::NotFound,
            _ => InstallCommandError::Failed(format!(
                "Failed to run `{command_label}` in {}: {error}",
                current_dir.display()
            )),
        })?;

    if status.success() {
        return Ok(());
    }

    let reason = match status.code() {
        Some(code) => format!("`{command_label}` failed with exit code {code}"),
        None => format!("`{command_label}` terminated by signal"),
    };

    Err(InstallCommandError::Failed(reason))
}
