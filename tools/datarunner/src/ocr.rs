//! CPU Tesseract; GPU RapidOCR if a `rapidocr` CLI is on PATH, else Tesseract.

use crate::config::OcrDevice;
use anyhow::{bail, Context, Result};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Clone, Debug)]
pub struct OcrResult {
    pub text: String,
    pub backend: &'static str,
    pub device: &'static str,
}

pub fn detect_gpu() -> OcrDevice {
    if which("nvidia-smi") || Path::new("/dev/nvidia0").exists() {
        return OcrDevice::Cuda;
    }
    if Path::new("/dev/kfd").exists() || which("rocminfo") {
        return OcrDevice::Rocm;
    }
    if intel_drm() {
        return OcrDevice::Openvino;
    }
    OcrDevice::Cpu
}

fn which(bin: &str) -> bool {
    env_path()
        .iter()
        .any(|dir| dir.join(bin).is_file() || dir.join(format!("{bin}.exe")).is_file())
}

fn env_path() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default()
}

fn intel_drm() -> bool {
    let drm = Path::new("/sys/class/drm");
    let Ok(entries) = fs::read_dir(drm) else {
        return false;
    };
    for ent in entries.flatten() {
        let uevent = ent.path().join("device/uevent");
        let Ok(raw) = fs::read_to_string(uevent) else {
            continue;
        };
        let low = raw.to_ascii_lowercase();
        if low.contains("i915") || low.contains("driver=xe") || low.contains("pci_id=8086") {
            return true;
        }
    }
    false
}

fn tesseract(image: &Path) -> Result<String> {
    if !which("tesseract") {
        bail!(
            "tesseract not found. Install the distro package (tesseract / tesseract-ocr). \
             GPU RapidOCR is used only when a `rapidocr` binary is on PATH."
        );
    }
    let out = Command::new("tesseract")
        .arg(image)
        .arg("stdout")
        .arg("--psm")
        .arg("6")
        .arg("-l")
        .arg("eng")
        .output()
        .context("spawn tesseract")?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        bail!("tesseract failed: {}", err.trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn rapidocr_cli(image: &Path) -> Result<String> {
    if !which("rapidocr") {
        bail!("rapidocr CLI not on PATH");
    }
    let out = Command::new("rapidocr")
        .arg(image)
        .output()
        .context("spawn rapidocr")?;
    if !out.status.success() {
        bail!("rapidocr exit {}", out.status);
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

pub fn image_to_text(image: &Path, device: OcrDevice) -> Result<OcrResult> {
    if !image.is_file() {
        bail!("{} is not a file", image.display());
    }
    let wanted = if device == OcrDevice::Auto {
        detect_gpu()
    } else {
        device
    };
    if wanted != OcrDevice::Cpu {
        match rapidocr_cli(image) {
            Ok(text) => {
                return Ok(OcrResult {
                    text,
                    backend: "rapidocr",
                    device: wanted.as_str(),
                });
            }
            Err(err) => {
                eprintln!(
                    "rapidocr failed on {} ({err}); using tesseract",
                    wanted.as_str()
                );
                let fallback = tesseract(image)?;
                return Ok(OcrResult {
                    text: fallback,
                    backend: "tesseract",
                    device: "cpu",
                });
            }
        }
    }
    Ok(OcrResult {
        text: tesseract(image)?,
        backend: "tesseract",
        device: "cpu",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_gpu_known_label() {
        let d = detect_gpu();
        assert!(matches!(
            d,
            OcrDevice::Cpu | OcrDevice::Cuda | OcrDevice::Rocm | OcrDevice::Openvino
        ));
    }
}
