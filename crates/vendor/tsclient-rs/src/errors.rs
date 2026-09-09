use std::fmt;
use thiserror::Error;

// ---- Individual error types (1:1 with TS) -----------------------------------

#[derive(Debug, Clone)]
pub struct TeamspeakError(pub String);

impl fmt::Display for TeamspeakError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for TeamspeakError {}

#[derive(Debug, Clone)]
pub struct ServerError {
    pub id: String,
    pub server_message: String,
}

impl fmt::Display for ServerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "TeamSpeak server error: {} (id={})", self.server_message, self.id)
    }
}

impl std::error::Error for ServerError {}

#[derive(Debug, Clone)]
pub struct CommandTimeoutError {
    pub command: String,
}

impl fmt::Display for CommandTimeoutError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "command timeout: {}", self.command)
    }
}

impl std::error::Error for CommandTimeoutError {}

#[derive(Debug, Clone)]
pub struct AlreadyConnectedError;

impl fmt::Display for AlreadyConnectedError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "already connecting or connected")
    }
}

impl std::error::Error for AlreadyConnectedError {}

#[derive(Debug, Clone)]
pub struct EAXTagMismatchError;

impl fmt::Display for EAXTagMismatchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "EAX tag mismatch")
    }
}

impl std::error::Error for EAXTagMismatchError {}

#[derive(Debug, Clone)]
pub struct FakeSignatureMismatchError;

impl fmt::Display for FakeSignatureMismatchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "fake signature mismatch")
    }
}

impl std::error::Error for FakeSignatureMismatchError {}

#[derive(Debug, Clone)]
pub struct FileTransferError(pub String);

impl fmt::Display for FileTransferError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for FileTransferError {}

#[derive(Debug, Clone)]
pub struct FileTransferTimeoutError;

impl fmt::Display for FileTransferTimeoutError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "timeout waiting for file transfer notification")
    }
}

impl std::error::Error for FileTransferTimeoutError {}

#[derive(Debug, Clone)]
pub struct CryptoInitError(pub String);

impl fmt::Display for CryptoInitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for CryptoInitError {}

#[derive(Debug, Clone)]
pub struct InvalidIdentityError(pub String);

impl fmt::Display for InvalidIdentityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for InvalidIdentityError {}

impl Default for InvalidIdentityError {
    fn default() -> Self {
        Self("invalid identity format".to_string())
    }
}

impl InvalidIdentityError {
    pub fn new() -> Self {
        Self::default()
    }
}

// ---- Main error enum (Rust-idiomatic, used internally) ----------------------

#[derive(Error, Debug, Clone)]
pub enum Error {
    #[error("{0}")]
    Teamspeak(String),

    #[error("TeamSpeak server error: {server_message} (id={id})")]
    ServerError {
        id: String,
        server_message: String,
    },

    #[error("command timeout: {command}")]
    CommandTimeout { command: String },

    #[error("already connecting or connected")]
    AlreadyConnected,

    #[error("EAX tag mismatch")]
    EaxTagMismatch,

    #[error("fake signature mismatch")]
    FakeSignatureMismatch,

    #[error("{0}")]
    FileTransfer(String),

    #[error("timeout waiting for file transfer notification")]
    FileTransferTimeout,

    #[error("{0}")]
    CryptoInit(String),

    #[error("{0}")]
    InvalidIdentity(String),
}

impl Error {
    pub fn invalid_identity() -> Self {
        Error::InvalidIdentity("invalid identity format".to_string())
    }
}

impl From<String> for Error {
    fn from(msg: String) -> Self {
        Error::Teamspeak(msg)
    }
}

impl From<&str> for Error {
    fn from(msg: &str) -> Self {
        Error::Teamspeak(msg.to_string())
    }
}

// ---- From impls: individual error types → Error ----------------------------

impl From<TeamspeakError> for Error {
    fn from(e: TeamspeakError) -> Self {
        Error::Teamspeak(e.0)
    }
}

impl From<ServerError> for Error {
    fn from(e: ServerError) -> Self {
        Error::ServerError { id: e.id, server_message: e.server_message }
    }
}

impl From<CommandTimeoutError> for Error {
    fn from(e: CommandTimeoutError) -> Self {
        Error::CommandTimeout { command: e.command }
    }
}

impl From<AlreadyConnectedError> for Error {
    fn from(_: AlreadyConnectedError) -> Self {
        Error::AlreadyConnected
    }
}

impl From<EAXTagMismatchError> for Error {
    fn from(_: EAXTagMismatchError) -> Self {
        Error::EaxTagMismatch
    }
}

impl From<FakeSignatureMismatchError> for Error {
    fn from(_: FakeSignatureMismatchError) -> Self {
        Error::FakeSignatureMismatch
    }
}

impl From<FileTransferError> for Error {
    fn from(e: FileTransferError) -> Self {
        Error::FileTransfer(e.0)
    }
}

impl From<FileTransferTimeoutError> for Error {
    fn from(_: FileTransferTimeoutError) -> Self {
        Error::FileTransferTimeout
    }
}

impl From<CryptoInitError> for Error {
    fn from(e: CryptoInitError) -> Self {
        Error::CryptoInit(e.0)
    }
}

impl From<InvalidIdentityError> for Error {
    fn from(e: InvalidIdentityError) -> Self {
        Error::InvalidIdentity(e.0)
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Teamspeak(e.to_string())
    }
}
