mod commands;
mod connection;
mod daemon;
mod paths;
mod skill;

use clap::{CommandFactory, Parser};
use commands::{generate_script, ActionCommand, ANNOTATE_SCREENSHOT_JS};
use connection::{connect_to_daemon, read_line, send_message};
use daemon::{
    current_daemon_pid, ensure_daemon, install_daemon_runtime, is_daemon_running,
    wait_for_daemon_exit,
};
use serde::Deserialize;
use serde_json::{json, Value};
use skill::install_skill;
use std::error::Error;
use std::fs;
use std::io::{self, BufRead, BufReader, IsTerminal, Read, Write};
use std::process;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const CLI_LONG_ABOUT: &str = r###"Web Interact — browser automation CLI for AI agents and scripts.

Individual commands (no scripting needed):
  web-interact open https://example.com             Navigate to a URL
  web-interact discover                              Show interactive elements [1], [2], ...
  web-interact click 3                               Click element [3]
  web-interact type 2 "hello"                        Type into element [2]
  web-interact fill 1 "John"                         Clear + fill element [1]
  web-interact screenshot                            Take a screenshot
  web-interact screenshot --annotate                 Screenshot with numbered element overlays
  web-interact find role button                      Find elements by semantic role
  web-interact get url                               Print current URL
  web-interact get styles h1 font-size               Get computed CSS
  web-interact storage local                         Read localStorage
  web-interact network route "*/api*" --body '{}'    Mock API responses
  web-interact eval "document.title"                 Run JavaScript

Actions are silent on success (exit 0). Getters print raw values.
Element indices auto-refresh when the page navigates.

Script mode (for multi-step workflows):
  web-interact run script.js
  web-interact <<'EOF'
    const page = await browser.getPage("main");
    await page.goto("https://example.com");
    const els = await browser.discover("main");
    console.log(els.serialized);
    await browser.click("main", 1);
  EOF

Modes:
  (default)              DOM mode — discover elements, act by index. No screenshots.
  --vision               Vision mode — plain screenshot after each command. Agent uses its eyes.
  --vision --annotate    Annotated vision — screenshot with numbered element overlays.

Flags:
  --browser NAME       Named browser instance (default: "default")
  --connect [URL]      Connect to running Chrome (auto-discovers if no URL)
  --headless           Launch without visible window
  --timeout SECONDS    Script timeout (default: 20s)"###;

const CLI_AFTER_LONG_HELP: &str = include_str!("../llm-guide.txt");

const DEFAULT_SCRIPT_TIMEOUT_SECS: u32 = 20;

#[derive(Parser)]
#[command(name = "web-interact")]
#[command(version)]
#[command(about = "Browser automation CLI for AI agents and scripts")]
#[command(long_about = CLI_LONG_ABOUT)]
#[command(after_long_help = CLI_AFTER_LONG_HELP)]
struct Cli {
    #[arg(
        long,
        default_value = "default",
        value_name = "NAME",
        help = "Use a named daemon-managed browser instance",
        global = true,
    )]
    browser: String,

    #[arg(
        long,
        num_args = 0..=1,
        default_missing_value = "auto",
        value_name = "URL",
        help = "Connect to a running Chrome instance",
        global = true,
    )]
    connect: Option<String>,

    #[arg(
        long,
        help = "Launch daemon-managed Chromium without a visible window",
        global = true,
    )]
    headless: bool,

    #[arg(
        long,
        help = "Ignore HTTPS certificate errors",
        global = true,
    )]
    ignore_https_errors: bool,

    #[arg(
        long,
        default_value_t = DEFAULT_SCRIPT_TIMEOUT_SECS,
        value_name = "SECONDS",
        value_parser = clap::value_parser!(u32).range(1..),
        help = "Maximum execution time in seconds",
        global = true,
    )]
    timeout: u32,

    #[arg(
        long,
        value_name = "FILE",
        help = "Write command output to file instead of stdout (for large results)",
        global = true,
    )]
    save: Option<String>,

    #[arg(
        long,
        help = "Vision mode: screenshot after each command (add --annotate for element overlays)",
        global = true,
    )]
    vision: bool,

    #[arg(
        long,
        requires = "vision",
        help = "Add numbered element overlays to vision screenshots",
        global = true,
    )]
    annotate: bool,

    #[command(subcommand)]
    command: Option<ActionCommand>,
}

#[derive(Debug, Deserialize)]
struct BrowserSummary {
    name: String,
    #[serde(rename = "type")]
    kind: String,
    status: String,
    pages: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct StatusSummary {
    pid: i32,
    #[serde(rename = "uptimeMs")]
    uptime_ms: u64,
    #[serde(rename = "browserCount")]
    browser_count: usize,
    #[serde(rename = "socketPath")]
    socket_path: String,
    browsers: Vec<BrowserSummary>,
}

enum ResultMode {
    None,
    Json,
    Browsers,
    Status,
}

fn main() {
    let exit_code = match run() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("Error: {error}");
            1
        }
    };

    process::exit(exit_code);
}

fn run() -> Result<i32, Box<dyn Error>> {
    let cli = Cli::parse();

    match &cli.command {
        // Commands handled without script generation
        Some(ActionCommand::Run { file }) => {
            let script = fs::read_to_string(file)?;
            run_script(&cli, script)
        }
        Some(ActionCommand::Browsers) => {
            ensure_daemon()?;
            send_request(
                json!({
                    "id": request_id("browsers"),
                    "type": "browsers",
                }),
                ResultMode::Browsers,
                None,
            )
        }
        Some(ActionCommand::Install) => {
            install_daemon_runtime()?;
            Ok(0)
        }
        Some(ActionCommand::InstallSkill) => {
            install_skill()?;
            Ok(0)
        }
        Some(ActionCommand::Status) => {
            ensure_daemon()?;
            send_request(
                json!({
                    "id": request_id("status"),
                    "type": "status",
                }),
                ResultMode::Status,
                None,
            )
        }
        Some(ActionCommand::Stop) => {
            if !is_daemon_running() {
                println!("Daemon is not running.");
                return Ok(0);
            }

            let daemon_pid = current_daemon_pid();

            let exit_code = send_request(
                json!({
                    "id": request_id("stop"),
                    "type": "stop",
                }),
                ResultMode::None,
                None,
            )?;

            if exit_code == 0 {
                if let Some(pid) = daemon_pid {
                    wait_for_daemon_exit(pid, Duration::from_secs(10))?;
                }
                println!("Daemon stopped.");
            }

            Ok(exit_code)
        }
        // Close --all uses the browser-stop protocol message
        Some(ActionCommand::Close { all: true, .. }) => {
            ensure_daemon()?;
            send_request(
                json!({
                    "id": request_id("browser-stop"),
                    "type": "browser-stop",
                    "browser": cli.browser,
                }),

                ResultMode::Json,
                None,
            )
        }
        // All other commands generate a script
        Some(cmd) => {
            if let Some(script) = generate_script(cmd) {
                run_script(&cli, script)
            } else {
                eprintln!("Command not implemented");
                Ok(1)
            }
        }
        None => {
            if stdin_is_tty() {
                let mut command = Cli::command();
                command.print_help()?;
                println!();
                return Ok(2);
            }

            let script = read_script_from_stdin()?;
            run_script(&cli, script)
        }
    }
}

fn run_script(cli: &Cli, script: String) -> Result<i32, Box<dyn Error>> {
    ensure_daemon()?;

    let timeout_ms = u64::from(cli.timeout)
        .checked_mul(1_000)
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "Timeout value is too large")
        })?;

    let exit_code = send_execute(cli, &script, timeout_ms)?;

    // Vision mode: screenshot after each command
    if cli.vision && exit_code == 0 {
        let page_js = serde_json::to_string(&cli.browser).unwrap_or_else(|_| "\"default\"".into());

        let script = if cli.annotate {
            format!(
                "const page = await browser.getPage({page});\nconst els = await browser.discover({page});\nconst SCREENSHOT_OPTS = {{}};\nconst buf = {annotate_fn};\nconst p = await saveScreenshot(buf, \"vision.png\");\nconsole.error(\"vision:\" + p);",
                page = page_js,
                annotate_fn = ANNOTATE_SCREENSHOT_JS,
            )
        } else {
            format!(
                "const page = await browser.getPage({page});\nconst buf = await page.screenshot();\nconst p = await saveScreenshot(buf, \"vision.png\");\nconsole.error(\"vision:\" + p);",
                page = page_js,
            )
        };
        // Vision script must not use --save (would overwrite the main command's output file)
        let _ = send_vision_script(cli, &script);
    }

    Ok(exit_code)
}

fn send_vision_script(cli: &Cli, script: &str) -> Result<i32, Box<dyn Error>> {
    let mut request = json!({
        "id": request_id("vision"),
        "type": "execute",
        "browser": cli.browser,
        "script": script,
        "timeoutMs": 15_000,
    });
    if cli.headless {
        request["headless"] = Value::Bool(true);
    }
    if cli.ignore_https_errors {
        request["ignoreHTTPSErrors"] = Value::Bool(true);
    }
    if let Some(endpoint) = &cli.connect {
        request["connect"] = Value::String(endpoint.clone());
    }
    send_request(request, ResultMode::Json, None)
}

fn send_execute(cli: &Cli, script: &str, timeout_ms: u64) -> Result<i32, Box<dyn Error>> {
    let mut request = json!({
        "id": request_id("execute"),
        "type": "execute",
        "browser": cli.browser,
        "script": script,
        "timeoutMs": timeout_ms,
    });

    if cli.headless {
        request["headless"] = Value::Bool(true);
    }

    if cli.ignore_https_errors {
        request["ignoreHTTPSErrors"] = Value::Bool(true);
    }

    if let Some(endpoint) = &cli.connect {
        request["connect"] = Value::String(endpoint.clone());
    }

    send_request(request, ResultMode::Json, cli.save.as_deref())
}

fn send_request(message: Value, result_mode: ResultMode, save_path: Option<&str>) -> Result<i32, Box<dyn Error>> {
    let mut stream = connect_to_daemon()?;
    send_message(&mut stream, &message)?;
    let mut reader = BufReader::new(stream);
    stream_responses(&mut reader, result_mode, save_path)
}

/// Max stdout bytes before truncation (128KB). Use --save for larger output.
const MAX_STDOUT_BYTES: usize = 128 * 1024;

fn stream_responses<R: BufRead>(
    reader: &mut R,
    result_mode: ResultMode,
    save_path: Option<&str>,
) -> Result<i32, Box<dyn Error>> {
    let mut save_file: Option<fs::File> = match save_path {
        Some(p) => Some(fs::File::create(p)?),
        None => None,
    };
    let mut stdout_bytes: usize = 0;
    let mut truncated = false;

    loop {
        let line = read_line(reader)?;
        let message: Value = serde_json::from_str(line.trim_end())?;

        match message.get("type").and_then(Value::as_str) {
            Some("stdout") => {
                if let Some(data) = message.get("data").and_then(Value::as_str) {
                    if let Some(ref mut f) = save_file {
                        use std::io::Write as _;
                        f.write_all(data.as_bytes())?;
                    } else if !truncated {
                        stdout_bytes += data.len();
                        if stdout_bytes > MAX_STDOUT_BYTES {
                            // Print what fits, then truncate
                            let remaining = MAX_STDOUT_BYTES.saturating_sub(stdout_bytes - data.len());
                            if remaining > 0 {
                                print!("{}", &data[..remaining.min(data.len())]);
                            }
                            eprintln!("\n[output truncated at 128KB — use --save <file> for full output]");
                            truncated = true;
                        } else {
                            print!("{data}");
                            io::stdout().flush()?;
                        }
                    }
                }
            }
            Some("stderr") => {
                if let Some(data) = message.get("data").and_then(Value::as_str) {
                    eprint!("{data}");
                    io::stderr().flush()?;
                }
            }
            Some("result") => {
                if let Some(data) = message.get("data") {
                    render_result(data, &result_mode)?;
                }
            }
            Some("complete") => {
                if let Some(p) = save_path {
                    if save_file.is_some() {
                        eprintln!("saved:{p}");
                    }
                }
                return Ok(0);
            }
            Some("error") => {
                let error_message = message
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Unknown daemon error");
                eprintln!("{error_message}");
                return Ok(1);
            }
            _ => {}
        }
    }
}

fn render_result(data: &Value, result_mode: &ResultMode) -> Result<(), Box<dyn Error>> {
    match result_mode {
        ResultMode::None => {}
        ResultMode::Json => {
            if data.is_null() {
                return Ok(());
            }

            if let Some(text) = data.as_str() {
                println!("{text}");
            } else {
                println!("{}", serde_json::to_string_pretty(data)?);
            }
        }
        ResultMode::Browsers => print_browsers(data)?,
        ResultMode::Status => print_status(data)?,
    }

    Ok(())
}

fn print_browsers(data: &Value) -> Result<(), Box<dyn Error>> {
    let browsers: Vec<BrowserSummary> = serde_json::from_value(data.clone())?;
    if browsers.is_empty() {
        println!("No browsers.");
        return Ok(());
    }

    let page_values: Vec<String> = browsers
        .iter()
        .map(|browser| {
            if browser.pages.is_empty() {
                "-".to_string()
            } else {
                browser.pages.join(", ")
            }
        })
        .collect();

    let name_width = browsers
        .iter()
        .map(|browser| browser.name.len())
        .max()
        .unwrap_or(4)
        .max("NAME".len());
    let type_width = browsers
        .iter()
        .map(|browser| browser.kind.len())
        .max()
        .unwrap_or(4)
        .max("TYPE".len());
    let status_width = browsers
        .iter()
        .map(|browser| browser.status.len())
        .max()
        .unwrap_or(6)
        .max("STATUS".len());

    println!(
        "{:<name_width$}  {:<type_width$}  {:<status_width$}  PAGES",
        "NAME", "TYPE", "STATUS"
    );

    for (browser, pages) in browsers.iter().zip(page_values.iter()) {
        println!(
            "{:<name_width$}  {:<type_width$}  {:<status_width$}  {}",
            browser.name, browser.kind, browser.status, pages
        );
    }

    Ok(())
}

fn print_status(data: &Value) -> Result<(), Box<dyn Error>> {
    let status: StatusSummary = serde_json::from_value(data.clone())?;

    println!("PID: {}", status.pid);
    println!("Uptime: {}", format_duration_ms(status.uptime_ms));
    println!("Browsers: {}", status.browser_count);
    println!("Socket: {}", status.socket_path);

    if !status.browsers.is_empty() {
        let managed = status
            .browsers
            .iter()
            .map(|browser| format!("{} ({}, {})", browser.name, browser.kind, browser.status))
            .collect::<Vec<_>>()
            .join(", ");
        println!("Managed: {managed}");
    }

    Ok(())
}

fn read_script_from_stdin() -> io::Result<String> {
    let mut script = String::new();
    io::stdin().read_to_string(&mut script)?;
    Ok(script)
}

fn stdin_is_tty() -> bool {
    io::stdin().is_terminal()
}

fn request_id(prefix: &str) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("{prefix}-{now}-{}", process::id())
}

fn format_duration_ms(duration_ms: u64) -> String {
    if duration_ms < 1_000 {
        return format!("{duration_ms}ms");
    }

    if duration_ms < 60_000 {
        return format!("{:.1}s", duration_ms as f64 / 1_000.0);
    }

    let total_seconds = duration_ms / 1_000;
    let minutes = total_seconds / 60;
    let seconds = total_seconds % 60;
    format!("{minutes}m {seconds}s")
}
