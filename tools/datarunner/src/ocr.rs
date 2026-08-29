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

/// Crop the 4.x kiosk shop column on ultrawide in-world shots, grayscale, 2×.
fn preprocess_kiosk(image: &Path) -> Result<PathBuf> {
    let img = image::open(image)
        .with_context(|| format!("decode {}", image.display()))?
        .to_rgb8();
    let (w, h) = img.dimensions();
    let cropped = if w as f32 / h.max(1) as f32 >= 1.8 {
        let x = (w as f32 * 0.52) as u32;
        let y = (h as f32 * 0.16) as u32;
        let cw = ((w as f32 * 0.80) as u32).saturating_sub(x).max(1);
        let ch = ((h as f32 * 0.88) as u32).saturating_sub(y).max(1);
        image::imageops::crop_imm(&img, x, y, cw, ch).to_image()
    } else {
        img
    };
    let gray = image::imageops::grayscale(&cropped);
    let stretched = stretch_luma(&gray);
    let scaled = image::imageops::resize(
        &stretched,
        stretched.width().saturating_mul(2).max(1),
        stretched.height().saturating_mul(2).max(1),
        image::imageops::FilterType::Lanczos3,
    );
    let tmp = std::env::temp_dir().join(format!(
        "datarunner-ocr-{}-{}.png",
        std::process::id(),
        image.file_stem().and_then(|s| s.to_str()).unwrap_or("shot")
    ));
    scaled
        .save(&tmp)
        .with_context(|| format!("write {}", tmp.display()))?;
    Ok(tmp)
}

fn stretch_luma(img: &image::GrayImage) -> image::GrayImage {
    let mut min_v = 255u8;
    let mut max_v = 0u8;
    for p in img.pixels() {
        min_v = min_v.min(p[0]);
        max_v = max_v.max(p[0]);
    }
    if max_v <= min_v {
        return img.clone();
    }
    let span = (max_v - min_v) as f32;
    let mut out = img.clone();
    for p in out.pixels_mut() {
        p[0] = (((p[0] - min_v) as f32 / span) * 255.0) as u8;
    }
    out
}

fn tesseract(image: &Path) -> Result<String> {
    if !which("tesseract") {
        bail!(
            "tesseract not found. Install the distro package (tesseract / tesseract-ocr). \
             GPU RapidOCR is used only when a `rapidocr` binary is on PATH."
        );
    }
    let pre = preprocess_kiosk(image).ok();
    let target = pre.as_deref().unwrap_or(image);
    let out = Command::new("tesseract")
        .arg(target)
        .arg("stdout")
        .arg("--psm")
        .arg("6")
        .arg("-l")
        .arg("eng")
        .output()
        .context("spawn tesseract")?;
    if let Some(p) = &pre {
        let _ = fs::remove_file(p);
    }
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
