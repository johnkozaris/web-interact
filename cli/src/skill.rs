use std::error::Error;
use std::fs;
use std::io::{self, IsTerminal};
use std::path::Path;
use std::process::Command;

const PLUGIN_REPO: &str = "https://github.com/johnkozaris/web-interact-plugin.git";
const PLUGIN_SKILL_PATHS: [&str; 4] = ["skills/web-interact", "skills/mode", "skills/browser-mode", "skills/click-to-fix"];
const INSTALL_ROOTS: [(&str, &str); 2] = [
    ("~/.claude/skills", ".claude/skills"),
    ("~/.agents/skills", ".agents/skills"),
];

pub fn install_skill() -> Result<(), Box<dyn Error>> {
    if !interactive_terminal_available() {
        return Err("`web-interact install-skill` requires an interactive terminal.".into());
    }

    println!("This clones the latest skill from {PLUGIN_REPO}");
    println!("and installs it to your Claude Code / agent skill directories.");
    println!();
    println!("Alternatively, add the plugin marketplace directly in Claude Code:");
    println!("  /plugin marketplace add johnkozaris/web-interact-plugin");
    println!();

    let home_dir =
        dirs::home_dir().ok_or("Could not determine the home directory.")?;

    // Clone to a temp dir
    let temp_dir = tempfile::tempdir()?;
    let clone_path = temp_dir.path().join("web-interact-plugin");

    eprintln!("Cloning latest skill from GitHub...");
    let status = Command::new("git")
        .args(["clone", "--depth", "1", "--quiet", PLUGIN_REPO])
        .arg(&clone_path)
        .status()?;

    if !status.success() {
        return Err(format!("Failed to clone {PLUGIN_REPO}").into());
    }

    for skill_path in &PLUGIN_SKILL_PATHS {
        let source_dir = clone_path.join(skill_path);
        if !source_dir.exists() {
            eprintln!("Skipping {skill_path} (not found in repo)");
            continue;
        }
        let skill_name = Path::new(skill_path).file_name().unwrap().to_str().unwrap();
        for (label_root, relative_root) in &INSTALL_ROOTS {
            let dest = home_dir.join(relative_root).join(skill_name);
            if dest.exists() {
                fs::remove_dir_all(&dest)?;
            }
            copy_dir_recursive(&source_dir, &dest)?;
            println!("Installed to {label_root}/{skill_name}");
        }
    }

    println!();
    println!("Done. Restart Claude Code to pick up the new skills.");

    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), Box<dyn Error>> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let dest_path = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &dest_path)?;
        } else {
            fs::copy(entry.path(), &dest_path)?;
        }
    }
    Ok(())
}

fn interactive_terminal_available() -> bool {
    io::stdin().is_terminal() && io::stderr().is_terminal()
}
