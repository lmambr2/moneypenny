//! Resolve Wine/Proton/LUG screenshot directories. Never hardcode C:\.

use anyhow::{bail, Result};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const GAME_REL: &str = "drive_c/Program Files/Roberts Space Industries/StarCitizen";

fn lug_conf_dir() -> PathBuf {
    let xdg = env::var("XDG_CONFIG_HOME").unwrap_or_else(|_| {
        dirs_fallback_home()
            .join(".config")
            .to_string_lossy()
            .into_owned()
    });
    PathBuf::from(xdg).join("starcitizen-lug")
}

fn dirs_fallback_home() -> PathBuf {
    env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn expand_tilde(path: PathBuf) -> PathBuf {
    let raw = path.to_string_lossy();
    if raw == "~" {
        return dirs_fallback_home();
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        return dirs_fallback_home().join(rest);
    }
    path
}

fn read_conf(path: &Path) -> Option<String> {
    fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub fn wine_prefix() -> Option<PathBuf> {
    if let Some(conf) = read_conf(&lug_conf_dir().join("winedir.conf")) {
        let p = expand_tilde(PathBuf::from(conf));
        if p.is_dir() {
            return Some(p);
        }
    }
    let default = dirs_fallback_home().join("Games/star-citizen");
    if default.is_dir() {
        return Some(default);
    }
    let umu = dirs_fallback_home().join("Games/umu/umu-starcitizen");
    umu.is_dir().then_some(umu)
}

pub fn screenshot_candidates(prefix: Option<&Path>) -> Vec<PathBuf> {
    let Some(root) = prefix.map(Path::to_path_buf).or_else(wine_prefix) else {
        return vec![];
    };
    let game = root.join(GAME_REL);
    if !game.is_dir() {
        return vec![];
    }
    let mut out = Vec::new();
    for env in ["LIVE", "PTU", "EPTU", "HOTFIX", "TECH-PREVIEW"] {
        let env_dir = game.join(env);
        if !env_dir.is_dir() {
            continue;
        }
        for name in ["ScreenShots", "Screenshots", "screenshots"] {
            let p = env_dir.join(name);
            if p.is_dir() {
                out.push(p);
            }
        }
    }
    out
}

pub fn resolve_watch_dir(explicit: Option<&Path>) -> Result<PathBuf> {
    if let Some(p) = explicit {
        let p = expand_tilde(p.to_path_buf());
        fs::create_dir_all(&p)?;
        return Ok(p);
    }
    if let Ok(env) = env::var("DATARUNNER_SCREENSHOT_DIR") {
        let t = env.trim();
        if !t.is_empty() {
            let p = expand_tilde(PathBuf::from(t));
            fs::create_dir_all(&p)?;
            return Ok(p);
        }
    }
    if let Some(found) = screenshot_candidates(None).into_iter().next() {
        return Ok(found);
    }
    bail!(
        "No screenshot directory. Pass --dir, set DATARUNNER_SCREENSHOT_DIR, \
         or install Star Citizen via LUG Helper (winedir.conf)."
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn game_rel_is_posix_wine_path() {
        assert!(GAME_REL.starts_with("drive_c/"));
        assert!(!GAME_REL.contains('\\'));
        assert!(!GAME_REL.contains("C:"));
    }

    #[test]
    fn expand_tilde_home() {
        let home = dirs_fallback_home();
        assert_eq!(expand_tilde(PathBuf::from("~")), home);
        assert_eq!(
            expand_tilde(PathBuf::from("~/Games/star-citizen")),
            home.join("Games/star-citizen")
        );
        assert_eq!(
            expand_tilde(PathBuf::from("/abs/path")),
            PathBuf::from("/abs/path")
        );
    }
}
