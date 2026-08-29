use anyhow::{bail, Result};
use std::env;
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Destination {
    Uex,
    Moneypenny,
    Both,
}

impl Destination {
    pub fn parse(raw: &str) -> Result<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "uex" => Ok(Self::Uex),
            "moneypenny" => Ok(Self::Moneypenny),
            "both" => Ok(Self::Both),
            other => bail!("DATARUNNER_DESTINATION must be uex | moneypenny | both (got {other})"),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Uex => "uex",
            Self::Moneypenny => "moneypenny",
            Self::Both => "both",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OcrDevice {
    Auto,
    Cpu,
    Cuda,
    Rocm,
    Openvino,
}

impl OcrDevice {
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "cpu" => Self::Cpu,
            "cuda" => Self::Cuda,
            "rocm" => Self::Rocm,
            "openvino" | "intel" => Self::Openvino,
            _ => Self::Auto,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Cpu => "cpu",
            Self::Cuda => "cuda",
            Self::Rocm => "rocm",
            Self::Openvino => "openvino",
        }
    }
}

#[derive(Clone, Debug)]
pub struct RunnerConfig {
    pub destination: Destination,
    pub screenshot_dir: Option<PathBuf>,
    pub moneypenny_url: String,
    pub moneypenny_token: String,
    pub uex_api_base: String,
    pub uex_api_token: String,
    pub uex_secret_key: String,
    pub uex_is_production: bool,
    pub game_version: String,
    pub environment: String,
    pub ocr_device: OcrDevice,
    pub terminal_id: Option<i64>,
    pub terminal_name: String,
    pub snapshot_type: String,
    pub yes: bool,
}

fn env_str(name: &str, default: &str) -> String {
    match env::var(name) {
        Ok(s) if !s.trim().is_empty() => s.trim().to_string(),
        _ => default.to_string(),
    }
}

impl RunnerConfig {
    pub fn from_env() -> Result<Self> {
        let dest = Destination::parse(&env_str("DATARUNNER_DESTINATION", "moneypenny"))?;
        let mut env = env_str("DATARUNNER_ENVIRONMENT", "LIVE").to_ascii_uppercase();
        if env != "LIVE" && env != "PTU" {
            env = "LIVE".into();
        }
        let device = OcrDevice::parse(&env::var("OCR_DEVICE").unwrap_or_default());
        let term = env::var("DATARUNNER_TERMINAL_ID")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .and_then(|s| s.parse().ok());
        let dir = env::var("DATARUNNER_SCREENSHOT_DIR")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .map(PathBuf::from);
        let token = {
            let a = env::var("MONEYPENNY_INGEST_TOKEN").unwrap_or_default();
            let b = env::var("ECONOMY_INGEST_TOKEN").unwrap_or_default();
            let t = a.trim();
            if t.is_empty() {
                b.trim().to_string()
            } else {
                t.to_string()
            }
        };
        let uex_token = {
            let a = env::var("UEX_API_TOKEN").unwrap_or_default();
            let b = env::var("UEX_API_KEY").unwrap_or_default();
            let t = a.trim();
            if t.is_empty() {
                b.trim().to_string()
            } else {
                t.to_string()
            }
        };
        let prod = matches!(
            env_str("UEX_IS_PRODUCTION", "0")
                .to_ascii_lowercase()
                .as_str(),
            "1" | "true" | "yes"
        );
        Ok(Self {
            destination: dest,
            screenshot_dir: dir,
            moneypenny_url: env_str("MONEYPENNY_INGEST_URL", "http://127.0.0.1:3000")
                .trim_end_matches('/')
                .to_string(),
            moneypenny_token: token,
            uex_api_base: env_str("UEX_API_BASE", "https://api.uexcorp.uk")
                .trim_end_matches('/')
                .to_string(),
            uex_api_token: uex_token,
            uex_secret_key: env::var("UEX_SECRET_KEY")
                .unwrap_or_default()
                .trim()
                .to_string(),
            uex_is_production: prod,
            game_version: env_str("DATARUNNER_GAME_VERSION", "4.10.0"),
            environment: env,
            ocr_device: device,
            terminal_id: term,
            terminal_name: env::var("DATARUNNER_TERMINAL_NAME")
                .unwrap_or_default()
                .trim()
                .to_string(),
            snapshot_type: env_str("DATARUNNER_TYPE", "commodity"),
            yes: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destination_parse() {
        assert_eq!(
            Destination::parse("moneypenny").unwrap(),
            Destination::Moneypenny
        );
        assert_eq!(Destination::parse("UEX").unwrap(), Destination::Uex);
        assert_eq!(Destination::parse(" both ").unwrap(), Destination::Both);
        assert!(Destination::parse("windows").is_err());
    }

    #[test]
    fn ocr_device_aliases() {
        assert_eq!(OcrDevice::parse("intel"), OcrDevice::Openvino);
        assert_eq!(OcrDevice::parse("CPU"), OcrDevice::Cpu);
        assert_eq!(OcrDevice::parse(""), OcrDevice::Auto);
    }
}
