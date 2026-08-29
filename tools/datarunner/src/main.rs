use anyhow::Result;
use clap::{Parser, Subcommand};
use datarunner::config::{Destination, OcrDevice, RunnerConfig};
use datarunner::ocr::image_to_text;
use datarunner::parse::parse_ocr_text;
use datarunner::paths::resolve_watch_dir;
use datarunner::review::{confirm, format_table};
use datarunner::snapshot::build_snapshot;
use datarunner::submit::{http_json, submit_snapshot, SubmitError};
use datarunner::watch::watch_dir;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

#[derive(Parser)]
#[command(
    name = "datarunner",
    about = "Linux-native Star Citizen kiosk datarunner (Moneypenny / UEX)."
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Inotify a screenshot directory
    Watch {
        #[command(flatten)]
        common: Common,
        /// Screenshot directory (not C:\\…)
        #[arg(long)]
        dir: Option<PathBuf>,
    },
    /// OCR one image and print text/rows
    Ocr {
        #[command(flatten)]
        common: Common,
        #[arg(long)]
        image: PathBuf,
    },
    /// POST a snapshot JSON
    Submit {
        #[command(flatten)]
        common: Common,
        #[arg(long)]
        file: PathBuf,
        #[arg(long)]
        screenshot: Option<PathBuf>,
    },
}

#[derive(clap::Args)]
struct Common {
    /// uex | moneypenny | both
    #[arg(long, value_parser = parse_dest)]
    dest: Option<Destination>,
    /// auto | cpu | cuda | rocm | openvino
    #[arg(long, value_parser = parse_device)]
    device: Option<OcrDevice>,
    /// Skip review confirm
    #[arg(long)]
    yes: bool,
    #[arg(long)]
    terminal_id: Option<i64>,
    #[arg(long, default_value = "")]
    terminal_name: String,
    #[arg(long, default_value = "commodity")]
    r#type: String,
    #[arg(long)]
    environment: Option<String>,
}

fn parse_dest(s: &str) -> Result<Destination, String> {
    Destination::parse(s).map_err(|e| e.to_string())
}

fn parse_device(s: &str) -> Result<OcrDevice, String> {
    Ok(OcrDevice::parse(s))
}

fn apply_common(cfg: &mut RunnerConfig, c: &Common) {
    if let Some(d) = c.dest {
        cfg.destination = d;
    }
    if let Some(d) = c.device {
        cfg.ocr_device = d;
    }
    cfg.yes = c.yes;
    if c.terminal_id.is_some() {
        cfg.terminal_id = c.terminal_id;
    }
    if !c.terminal_name.is_empty() {
        cfg.terminal_name = c.terminal_name.clone();
    }
    if c.r#type != "commodity" || cfg.snapshot_type.is_empty() {
        cfg.snapshot_type = c.r#type.clone();
    }
    if let Some(env) = &c.environment {
        cfg.environment = env.to_ascii_uppercase();
    }
}

fn process_image(cfg: &RunnerConfig, image: &Path) -> i32 {
    eprintln!(
        "OCR {} (device={})",
        image.display(),
        cfg.ocr_device.as_str()
    );
    let ocr = match image_to_text(image, cfg.ocr_device) {
        Ok(o) => o,
        Err(err) => {
            eprintln!("{err}");
            return 1;
        }
    };
    eprintln!("backend={} device={}", ocr.backend, ocr.device);
    let prices = parse_ocr_text(&ocr.text);
    println!("{}", format_table(&prices));
    if prices.is_empty() {
        eprintln!("No rows parsed. Correct the image or type, then retry.");
        return 2;
    }
    let Some(tid) = cfg.terminal_id else {
        eprintln!("Set --terminal-id (UEX id_terminal) before submit.");
        return 2;
    };
    if !confirm(
        &format!(
            "Submit {} rows to {}?",
            prices.len(),
            cfg.destination.as_str()
        ),
        cfg.yes,
    ) {
        println!("skipped");
        return 0;
    }
    let snap = match build_snapshot(
        prices,
        tid,
        &cfg.terminal_name,
        &cfg.snapshot_type,
        &cfg.game_version,
        &cfg.environment,
        Some(image),
    ) {
        Ok(s) => s,
        Err(err) => {
            eprintln!("{err}");
            return 1;
        }
    };
    match submit_snapshot(cfg, &snap, Some(image), http_json) {
        Ok(result) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&result).unwrap_or_default()
            );
            0
        }
        Err(err) => {
            if let Some(se) = err.downcast_ref::<SubmitError>() {
                eprintln!("{} submit failed: {se}", se.dest);
            } else {
                eprintln!("submit failed: {err}");
            }
            1
        }
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let mut cfg = match RunnerConfig::from_env() {
        Ok(c) => c,
        Err(err) => {
            eprintln!("{err}");
            return ExitCode::from(1);
        }
    };
    let code = match cli.cmd {
        Cmd::Watch { common, dir } => {
            apply_common(&mut cfg, &common);
            if dir.is_some() {
                cfg.screenshot_dir = dir.clone();
            }
            let directory = match resolve_watch_dir(dir.as_deref()) {
                Ok(p) => p,
                Err(err) => {
                    eprintln!("{err}");
                    return ExitCode::from(1);
                }
            };
            eprintln!(
                "watching {} dest={} device={}",
                directory.display(),
                cfg.destination.as_str(),
                cfg.ocr_device.as_str()
            );
            if let Err(err) = watch_dir(&directory, |p| {
                let _ = process_image(&cfg, &p);
            }) {
                eprintln!("{err}");
                return ExitCode::from(1);
            }
            0
        }
        Cmd::Ocr { common, image } => {
            apply_common(&mut cfg, &common);
            match image_to_text(&image, cfg.ocr_device) {
                Ok(ocr) => {
                    eprintln!("# backend={} device={}", ocr.backend, ocr.device);
                    println!("{}", ocr.text);
                    let prices = parse_ocr_text(&ocr.text);
                    eprintln!("\n# parsed:\n{}", format_table(&prices));
                    0
                }
                Err(err) => {
                    eprintln!("{err}");
                    1
                }
            }
        }
        Cmd::Submit {
            common,
            file,
            screenshot,
        } => {
            apply_common(&mut cfg, &common);
            match (|| -> Result<()> {
                let raw = std::fs::read_to_string(&file)?;
                let snap: datarunner::snapshot::Snapshot = serde_json::from_str(&raw)?;
                let result = submit_snapshot(&cfg, &snap, screenshot.as_deref(), http_json)?;
                println!("{}", serde_json::to_string_pretty(&result)?);
                Ok(())
            })() {
                Ok(()) => 0,
                Err(err) => {
                    eprintln!("{err}");
                    1
                }
            }
        }
    };
    ExitCode::from(code as u8)
}
