// Clippy style nags that don't affect correctness
// (most have no equivalent in the JS reference)
#![allow(
    clippy::collapsible_if,
    clippy::too_many_arguments,
    clippy::await_holding_lock,
    clippy::single_match,
    clippy::unnecessary_unwrap,
    clippy::manual_range_contains,
    clippy::needless_range_loop,
    clippy::manual_div_ceil,
    clippy::manual_is_multiple_of,
    clippy::upper_case_acronyms,
    clippy::inherent_to_string,
    clippy::never_loop,
    clippy::needless_borrow,
    clippy::clone_on_copy,
    clippy::needless_borrows_for_generic_args,
    clippy::redundant_guards,
    clippy::collapsible_else_if,
    clippy::identity_op,
    clippy::explicit_auto_deref,
    clippy::question_mark,
    clippy::new_without_default,
)]

// Modules (private to crate, selectively re-exported below)
mod api;
mod client;
mod command;
mod commands;
mod crypto;
mod discovery;
mod events;
mod handshake;
mod helpers;
mod notifications;
mod throttle;
mod transfer;
mod transport;

// Modules (accessible within crate, selectively re-exported below)
mod errors;
mod types;

// ---- Main client ----------------------------------------------------------------

pub use client::{Client, ClientStatus};
pub use types::ClientState;

// ---- Public types ---------------------------------------------------------------

/// Maps event names to payload types (TS `EventMap` equivalent).
pub use types::Event as EventMap;

pub use types::{
    TextMessage,
    ClientMovedEvent,
    ClientLeftViewEvent,
    ClientInfo,
    ChannelInfo,
    PokeEvent,
    VoiceData,
    FileUploadInfo,
    FileDownloadInfo,
    FileTransferStatusInfo,
    CommandMiddleware,
    EventMiddleware,
    Logger,
    AddrResolver,
    ClientOptions,
    ResolvedAddr,
    EscapedString,
    KickReason,
    AbortSignal,
    Event,
    NoopLogger as noopLogger,
    ConsoleLogger as consoleLogger,
};

// ---- Errors ---------------------------------------------------------------------

pub use errors::Error;

pub use errors::{
    TeamspeakError,
    ServerError,
    CommandTimeoutError,
    AlreadyConnectedError,
    EAXTagMismatchError,
    FakeSignatureMismatchError,
    FileTransferError,
    FileTransferTimeoutError,
    CryptoInitError,
    InvalidIdentityError,
};

// ---- High-level API helpers ----------------------------------------------------

pub use api::{
    send_text_message as sendTextMessage,
    client_move as clientMove,
    client_kick as clientKick,
    ban_client as banClient,
    client_update as clientUpdate,
    poke,
    get_client_info as getClientInfo,
    list_channels as listChannels,
    list_clients as listClients,
    file_transfer_delete_file as fileTransferDeleteFile,
};

pub use command::escape;

// ---- File transfer -------------------------------------------------------------

pub use transfer::{
    dial_file_transfer as dialFileTransfer,
    upload_file_data as uploadFileData,
    download_file_data as downloadFileData,
};

// ---- Crypto (identity management) ---------------------------------------------

pub use crypto::{
    Identity,
    identity_from_string as identityFromString,
    generate_identity as generateIdentity,
    get_uid_from_public_key as getUidFromPublicKey,
};
