//! File transfer — mirrors `teamspeak-js/src/transfer.ts`

use std::collections::HashMap;

use aes::Aes128;
use cipher::{BlockDecrypt, BlockEncrypt, KeyInit};
use cipher::generic_array::GenericArray;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::oneshot;

use crate::command::build_command;
use crate::types::*;

#[derive(Debug, Clone)]
pub enum FtNotification {
    Upload(FileUploadInfo),
    Download(FileDownloadInfo),
    Status(FileTransferStatusInfo),
}

pub struct FileTransferTracker {
    pending: HashMap<i32, oneshot::Sender<FtNotification>>,
    next_id: i32,
}

impl FileTransferTracker {
    pub fn new() -> Self {
        Self {
            pending: HashMap::new(),
            next_id: 0,
        }
    }

    pub fn register(&mut self) -> (i32, oneshot::Receiver<FtNotification>) {
        self.next_id += 1;
        if self.next_id > 65535 {
            self.next_id = 1;
        }
        let cftid = self.next_id;
        let (tx, rx) = oneshot::channel();
        self.pending.insert(cftid, tx);
        (cftid, rx)
    }

    pub fn unregister(&mut self, cftid: i32) {
        self.pending.remove(&cftid);
    }

    pub fn notify(&mut self, cftid: i32, value: FtNotification) {
        if let Some(sender) = self.pending.remove(&cftid) {
            let _ = sender.send(value);
        }
    }

    pub fn reset(&mut self) {
        self.pending.clear();
        self.next_id = 0;
    }
}

/// Connect to the file transfer port.
/// Mirrors JS `dialFileTransfer` — just connects, does NOT send the key.
pub async fn dial_file_transfer(
    host: &str,
    port: u16,
) -> Result<tokio::net::TcpStream, crate::Error> {
    let addr = format!("{host}:{port}");
    let stream = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tokio::net::TcpStream::connect(&addr),
    )
    .await
    .map_err(|_| crate::Error::FileTransfer("connection timeout".into()))?
    .map_err(|e| crate::Error::FileTransfer(format!("failed to connect: {e}")))?;
    Ok(stream)
}

/// Upload file data with AES-128-ECB encryption.
/// Mirrors JS `uploadFileData(host, info, data: Readable)`.
/// `data` is an async reader — data is streamed and encrypted in 16-byte blocks.
pub async fn upload_file_data<R: AsyncRead + Unpin>(
    host: &str,
    info: &FileUploadInfo,
    mut data: R,
) -> Result<(), crate::Error> {
    let mut stream = dial_file_transfer(host, info.port as u16).await?;

    let key = base64_decode(&info.file_transfer_key);
    let cipher = Aes128::new_from_slice(&key)
        .map_err(|e| crate::Error::FileTransfer(format!("invalid AES key: {e}")))?;

    let mut read_buf = vec![0u8; 4096];
    let mut pending: Vec<u8> = Vec::new();

    loop {
        let n = data
            .read(&mut read_buf)
            .await
            .map_err(|e| crate::Error::FileTransfer(format!("read failed: {e}")))?;
        if n == 0 {
            break;
        }
        pending.extend_from_slice(&read_buf[..n]);

        // Encrypt complete 16-byte blocks
        let num_blocks = pending.len() / 16;
        for i in 0..num_blocks {
            let mut block = GenericArray::clone_from_slice(&pending[i * 16..(i + 1) * 16]);
            cipher.encrypt_block(&mut block);
            stream
                .write_all(&block)
                .await
                .map_err(|e| crate::Error::FileTransfer(format!("write failed: {e}")))?;
        }
        pending = pending[num_blocks * 16..].to_vec();
    }

    // JS: cipher.final() with setAutoPadding(false) — any remaining bytes
    // (< 16) are silently dropped, matching JS behavior.
    stream
        .shutdown()
        .await
        .map_err(|e| crate::Error::FileTransfer(format!("shutdown failed: {e}")))?;
    Ok(())
}

/// Download file data with AES-128-ECB decryption.
/// Mirrors JS `downloadFileData(host, info, dest: Writable)`.
/// `dest` is an async writer — decrypted data is streamed out.
pub async fn download_file_data<W: AsyncWrite + Unpin>(
    host: &str,
    info: &FileDownloadInfo,
    mut dest: W,
) -> Result<(), crate::Error> {
    let mut stream = dial_file_transfer(host, info.port as u16).await?;

    let key = base64_decode(&info.file_transfer_key);
    let cipher = Aes128::new_from_slice(&key)
        .map_err(|e| crate::Error::FileTransfer(format!("invalid AES key: {e}")))?;

    let mut read_buf = vec![0u8; 4096];
    let mut pending: Vec<u8> = Vec::new();

    loop {
        let n = stream
            .read(&mut read_buf)
            .await
            .map_err(|e| crate::Error::FileTransfer(format!("read failed: {e}")))?;
        if n == 0 {
            break;
        }
        pending.extend_from_slice(&read_buf[..n]);

        // Decrypt complete 16-byte blocks
        let num_blocks = pending.len() / 16;
        for i in 0..num_blocks {
            let mut block = GenericArray::clone_from_slice(&pending[i * 16..(i + 1) * 16]);
            cipher.decrypt_block(&mut block);
            dest.write_all(&block)
                .await
                .map_err(|e| crate::Error::FileTransfer(format!("write failed: {e}")))?;
        }
        pending = pending[num_blocks * 16..].to_vec();
    }

    // JS: decipher.final() with setAutoPadding(false) — remaining bytes dropped.
    dest.flush()
        .await
        .map_err(|e| crate::Error::FileTransfer(format!("flush failed: {e}")))?;
    Ok(())
}

fn base64_decode(s: &str) -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .unwrap_or_default()
}

pub fn build_ft_init_upload(
    channel_id: u64,
    path: &str,
    password: &str,
    size: u64,
    cftid: i32,
    overwrite: bool,
) -> String {
    let target_path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    let mut params = HashMap::new();
    params.insert("cid".to_string(), channel_id.to_string());
    params.insert("name".to_string(), target_path);
    params.insert("cpw".to_string(), password.to_string());
    params.insert("size".to_string(), size.to_string());
    params.insert("clientftfid".to_string(), cftid.to_string());
    params.insert("overwrite".to_string(), if overwrite { "1" } else { "0" }.to_string());
    params.insert("resume".to_string(), "0".to_string());
    build_command("ftinitupload", params)
}

pub fn build_ft_init_download(
    channel_id: u64,
    path: &str,
    password: &str,
    cftid: i32,
) -> String {
    let target_path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    let mut params = HashMap::new();
    params.insert("cid".to_string(), channel_id.to_string());
    params.insert("name".to_string(), target_path);
    params.insert("cpw".to_string(), password.to_string());
    params.insert("clientftfid".to_string(), cftid.to_string());
    params.insert("seekpos".to_string(), "0".to_string());
    build_command("ftinitdownload", params)
}
