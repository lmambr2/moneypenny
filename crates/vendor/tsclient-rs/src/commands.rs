//! Command tracking & return_code — mirrors `teamspeak-js/src/commands.ts`

use std::collections::HashMap;

use tokio::sync::oneshot;

use crate::Error;

#[derive(Debug, Clone)]
pub struct CommandResult {
    pub err: Option<Error>,
    pub data: Vec<HashMap<String, String>>,
}

/// Tracks in-flight commands by return_code.
///
/// The TS3/TS5 server sends a "welcome sequence" of unsolicited data immediately
/// after the connection handshake (channellist, channelclientlist, etc.). This
/// data arrives after we may have registered our first pending RC, which would
/// contaminate our command responses.
///
/// Solution: gate all row buffering on a `welcome_complete` flag. The flag is
/// set when `notifycliententerview` for our own clid arrives — the last event
/// the TS3/TS5 server sends in its welcome sequence. Any data arriving before
/// that is silently discarded.
pub struct CommandTracker {
    pending: HashMap<i32, oneshot::Sender<CommandResult>>,
    next_rc: i32,
    buffer: Vec<HashMap<String, String>>,
    welcome_complete: bool,
}

impl CommandTracker {
    pub fn new() -> Self {
        Self {
            pending: HashMap::new(),
            next_rc: 0,
            buffer: Vec::new(),
            welcome_complete: false,
        }
    }

    pub fn register(&mut self) -> (i32, oneshot::Receiver<CommandResult>) {
        self.next_rc += 1;
        let rc = self.next_rc;
        let (tx, rx) = oneshot::channel();
        self.pending.insert(rc, tx);
        (rc, rx)
    }

    pub fn unregister(&mut self, rc: i32) {
        self.pending.remove(&rc);
    }

    pub fn signal_welcome_complete(&mut self) {
        self.welcome_complete = true;
        self.buffer.clear();
    }

    pub fn buffer(&mut self, params: HashMap<String, String>) {
        if !self.welcome_complete {
            return;
        }
        if self.pending.is_empty() {
            return;
        }
        self.buffer.push(params);
    }

    pub fn resolve(&mut self, rc: i32, err: Option<Error>) {
        let sender = self.pending.remove(&rc);
        let sender = match sender {
            Some(s) => s,
            None => {
                self.buffer.clear();
                return;
            }
        };
        let data = std::mem::take(&mut self.buffer);
        let result = CommandResult { err, data };
        let _ = sender.send(result);
    }

    pub fn discard_buffer(&mut self) {
        self.buffer.clear();
    }

    pub fn reset(&mut self) {
        self.pending.clear();
        self.buffer.clear();
        self.welcome_complete = false;
        self.next_rc = 0;
    }
}

/// Parse and handle an `error` command from the server.
/// Returns the error (or None on success) and the resolved return_code.
pub fn parse_server_error(params: &HashMap<String, String>) -> (Option<Error>, Option<i32>) {
    let id = params.get("id").map(|s| s.as_str()).unwrap_or("0");
    let msg = params.get("msg").map(|s| s.as_str()).unwrap_or("");
    let rc_str = params.get("return_code");

    let err = if id != "0" {
        Some(Error::ServerError {
            id: id.to_string(),
            server_message: msg.to_string(),
        })
    } else {
        None
    };

    let rc = rc_str.and_then(|s| {
        if s.is_empty() {
            None
        } else {
            s.parse::<i32>().ok()
        }
    });

    (err, rc)
}

/// Append a return_code parameter to a command string if not already present.
pub fn append_return_code(cmd: &str, rc: i32) -> String {
    if cmd.contains("return_code=") {
        cmd.to_string()
    } else {
        format!("{} return_code={}", cmd, rc)
    }
}
