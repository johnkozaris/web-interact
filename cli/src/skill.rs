use std::error::Error;
use std::fs;
use std::io::{self, IsTerminal};
use std::path::Path;
use std::process::Command;

const PLUGIN_REPO: &str = "https://github.com/johnkozaris/web-interact-plugin.git";
const PLUGIN_SKILL_PATH: &str = "skills/web-interact";

struct InstallTarget {
    label: &'static str,
    relative_path: &'static str,
}

const INSTALL_TARGETS: [InstallTarget; 2] = [
    InstallTarget {
        label: "~/.claude/skills/web-interact",
        relative_path: ".claude/skills/web-interact",
    },
    InstallTarget {
        label: "~/.agents/skills/web-interact",
        relative_path: ".agents/skills/web-interact",
    },
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

    let source_skill_dir = clone_path.join(PLUGIN_SKILL_PATH);
    if !source_skill_dir.exists() {
        return Err(format!("Skill not found in cloned repo at {PLUGIN_SKILL_PATH}").into());
    }

    // Install to each target
    for target in &INSTALL_TARGETS {
        let dest = home_dir.join(target.relative_path);
        
        if dest.exists() {
            fs::remove_dir_all(&dest)?;
        }
        
        copy_dir_recursive(&source_skill_dir, &dest)?;
        println!("Installed to {}", target.label);
    }

    println!();
    println!("Done. Restart Claude Code to pick up the new skill.");

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
