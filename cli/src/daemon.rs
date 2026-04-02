use crate::connection::connect_to_daemon;
use crate::paths::{daemon_pid_path, read_mode, web_interact_base_dir};
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
const PLAYWRIGHT_VERSION: &str = "1.59.1";
const PATCHRIGHT_VERSION: &str = "1.59.1";
const QUICKJS_VERSION: &str = "0.32.0";

fn build_runtime_package_json(mode: &str) -> String {
    let use_patchright = mode == "assistant";

    let (pkg, core, version) = if use_patchright {
        ("patchright", "patchright-core", PATCHRIGHT_VERSION)
    } else {
        // npm alias: install playwright under the "patchright" name so the
        // daemon bundle's `import from "patchright"` resolves correctly.
        return format!(
            r#"{{
  "name": "web-interact-runtime",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.33.0",
  "dependencies": {{
    "patchright": "npm:playwright@{PLAYWRIGHT_VERSION}",
    "patchright-core": "npm:playwright-core@{PLAYWRIGHT_VERSION}",
    "quickjs-emscripten": "{QUICKJS_VERSION}"
  }}
}}"#
        );
    };

    format!(
        r#"{{
  "name": "web-interact-runtime",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.33.0",
  "dependencies": {{
    "{pkg}": "{version}",
    "{core}": "{version}",
    "quickjs-emscripten": "{QUICKJS_VERSION}"
  }}
}}"#
    )
}

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
    let mode = read_mode().unwrap_or_else(|_| "default".to_string());
    sync_text_file(&package_json_path, &build_runtime_package_json(&mode))?;

    Ok(daemon_path)
}

pub fn install_daemon_runtime() -> Result<(), Box<dyn Error>> {
    let base_dir = daemon_base_dir()?;
    ensure_daemon_extracted()?;
    run_package_manager_command(&["install", "--ignore-scripts"], &base_dir)?;

    if !system_browser_exists() {
        let mode = read_mode().unwrap_or_else(|_| "default".to_string());
        let browser_cli = if mode == "assistant" { "patchright" } else { "playwright" };
        eprintln!("No Chrome or Edge found — downloading Chromium as fallback...");
        run_package_manager_command(&["exec", browser_cli, "install", "chromium"], &base_dir)?;
    }

    Ok(())
}

/// Returns true if a usable Chrome or Edge binary exists on this system.
fn system_browser_exists() -> bool {
    for path in system_browser_paths() {
        if Path::new(path).exists() {
            return true;
        }
    }
    false
}

#[cfg(target_os = "macos")]
fn system_browser_paths() -> &'static [&'static str] {
    &[
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    ]
}

#[cfg(target_os = "linux")]
fn system_browser_paths() -> &'static [&'static str] {
    &[
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/microsoft-edge",
        "/usr/bin/microsoft-edge-stable",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
        "/snap/bin/chromium",
    ]
}

#[cfg(target_os = "windows")]
fn system_browser_paths() -> &'static [&'static str] {
    &[
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ]
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn system_browser_paths() -> &'static [&'static str] {
    &[]
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
    let mode = read_mode().unwrap_or_else(|_| "default".to_string());
    let package_json = build_runtime_package_json(&mode);
    serde_json::from_str::<EmbeddedRuntimeManifest>(&package_json)
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

    // npm aliases: "patchright": "npm:playwright@1.52.0" installs playwright
    // under node_modules/patchright, so check the aliased version too.
    let expected = if expected_version.starts_with("npm:") {
        expected_version.rsplit_once('@').map_or(expected_version, |(_, v)| v)
    } else {
        expected_version
    };

    installed_manifest.version == expected
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
