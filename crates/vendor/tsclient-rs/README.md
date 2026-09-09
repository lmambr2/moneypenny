<div align="center">

# tsclient-rs

**A clean-room TeamSpeak 3 client protocol library written in Rust.**

Compatible with TeamSpeak 3, 5 & 6. Ported from [teamspeak-js](https://github.com/honeybbq/teamspeak-js).

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

## Features

- **Full protocol handshake** — ECDH key exchange, RSA puzzle, EAX-encrypted transport
- **Command & notification system** — Send commands, receive server events
- **Event-driven API** — Register handlers for text messages, client enter/leave, channel moves, kicks, etc.
- **Voice data** — Send Opus voice packets (codec 4 & 5)
- **File transfers** — Upload, download, and delete files on the server
- **Address resolution** — SRV records, TSDNS, and direct address support
- **Middleware** — Pluggable command and event middleware chains
- **Built-in rate limiter** — Token-bucket throttling to prevent server-side flood kicks
- **Identity management** — Generate, import/export identities
- **Zero unsafe code** — Pure safe Rust, no `unsafe` blocks
- **Async-native** — Built on `tokio` with proper async cancellation and graceful shutdown

## Quick Start

```rust
use std::sync::Arc;
use tsclient_rs::*;

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt().init();

    let identity = generateIdentity(8);

    let mut client = Client::new(
        identity,
        "127.0.0.1:9987".to_string(),
        "MyBot".to_string(),
        ClientOptions {
            logger: Arc::new(noopLogger),
            ..Default::default()
        },
    );

    client.on_connected(Arc::new(|| println!("connected")));
    client.on_disconnected(Arc::new(|ev| println!("disconnected: {:?}", ev)));

    client.connect().await?;
    client.wait_connected(None).await?;

    println!("CLID: {}", client.client_id());

    let channels = listChannels(&client).await?;
    let clients = listClients(&client).await?;

    client.disconnect().await?;

    Ok(())
}
```

## API Overview

### Client Lifecycle

| Method                                     | Description                              |
| ------------------------------------------ | ---------------------------------------- |
| `Client::new(identity, addr, name, opts?)` | Create a new client                      |
| `client.connect()`                         | Initiate connection to the server        |
| `client.wait_connected(signal?)`           | Block until the handshake completes      |
| `client.disconnect()`                      | Gracefully disconnect (awaits bg tasks)  |
| `client.status()`                          | Get current `ClientStatus`               |
| `client.client_id()`                       | Get assigned client ID on the server     |
| `client.channel_id()`                      | Get current channel ID                   |

### Events

| Method                                    | Description                        |
| ----------------------------------------- | ---------------------------------- |
| `client.on_connected(handler)`            | Fires when fully connected         |
| `client.on_disconnected(handler)`         | Fires on disconnect                |
| `client.on_text_message(handler)`         | Fires on text messages             |
| `client.on_client_enter(handler)`         | Fires when a client joins          |
| `client.on_client_leave(handler)`         | Fires when a client leaves         |
| `client.on_client_moved(handler)`         | Fires when a client moves channels |
| `client.on_kicked(handler)`               | Fires when the bot is kicked       |
| `client.on_poked(handler)`                | Fires when poked by a client       |
| `client.on_voice_data(handler)`           | Fires on incoming voice data       |

### Commands

| Function                                               | Description                                |
| ------------------------------------------------------ | ------------------------------------------ |
| `sendTextMessage(client, targetMode, targetId, msg)`   | Send a text message                        |
| `clientMove(client, clid, channelId, password?)`       | Move a client to a channel                 |
| `poke(client, clid, message)`                          | Poke a client                              |
| `client.send_voice(data, codec)`                       | Send Opus voice data                       |
| `listChannels(client)`                                 | List all channels                          |
| `listClients(client)`                                  | List all connected clients                 |
| `getClientInfo(client, clid)`                          | Get detailed client information            |
| `client.exec_command(cmd, timeout?)`                   | Execute a raw command                      |
| `client.exec_command_with_response(cmd, timeout?)`     | Execute a command and return response data |
| `client.send_command_no_wait(cmd)`                     | Fire-and-forget command                    |

### File Transfers

| Function                                  | Description                       |
| ----------------------------------------- | --------------------------------- |
| `client.file_transfer_init_upload(...)`   | Initialize a file upload          |
| `client.file_transfer_init_download(...)` | Initialize a file download        |
| `fileTransferDeleteFile(client, ...)`     | Delete files on the server        |
| `uploadFileData(host, info, reader)`      | Transfer file data to the server  |
| `downloadFileData(host, info, writer)`    | Receive file data from the server |

### Identity

```rust
use tsclient_rs::*;

// Generate a new identity with security level 8
let identity = generateIdentity(8);

// Export to string for persistent storage
let exported = identity.export_string();

// Import from a previously exported string
let restored = identityFromString(&exported);

// Get UID from public key
let uid = getUidFromPublicKey(&identity.public_key);
```

### Options

```rust
let client = Client::new(identity, "ts.example.com", "MyBot", ClientOptions {
    logger: Arc::new(consoleLogger),
    resolver: None,                               // custom resolver
    command_middleware: vec![],                    // command middleware
    event_middleware: vec![],                      // event middleware
    server_password: Some("secret".into()),
    default_channel: Some("Lobby".into()),
    default_channel_password: Some("".into()),
});
```

## Middleware

```rust
use tsclient_rs::*;

struct LogMiddleware;

impl CommandMiddleware for LogMiddleware {
    fn wrap(&self, next: CommandHandler) -> CommandHandler {
        Arc::new(move |cmd: String| {
            println!(">> {cmd}");
            let next = next.clone();
            Box::pin(async move { next(cmd).await })
        })
    }
}

client.use_command_middleware(vec![Box::new(LogMiddleware)]);
```

## Architecture

```
tsclient-rs/
├── src/
│   ├── client.rs          # Client lifecycle, connection management
│   ├── api.rs             # High-level API (messages, channels, clients)
│   ├── commands.rs        # Command sending and response tracking
│   ├── events.rs          # Event handler registration and middleware
│   ├── notifications.rs   # Server notification parsing and dispatch
│   ├── handshake.rs       # Protocol handshake orchestration
│   ├── transfer.rs        # File transfer operations
│   ├── throttle.rs        # Token-bucket rate limiter
│   ├── types.rs           # Public type definitions
│   ├── errors.rs          # Error types
│   ├── crypto/            # ECDH, EAX encryption, identity management
│   ├── handshake/         # Crypto handshake and license verification
│   ├── transport/         # UDP packet framing, ACK, compression
│   ├── command/           # Command builder and parser
│   └── discovery/         # SRV / TSDNS / direct address resolution
├── test_tsclient/         # Integration test client
│   └── src/main.rs
├── teamspeak-js/          # Original JS reference implementation (submodule)
├── teamspeak-music-bot/   # Music bot using teamspeak-js (submodule)
├── Cargo.toml
└── LICENSE
```

## Dependencies

```toml
[dependencies]
tsclient-rs = { git = "https://github.com/anomalyco/tsclient-rs" }
tokio = { version = "1", features = ["rt", "macros", "net", "time"] }
tracing = "0.1"
```

## Known Dead Code

The following items are unused but kept for API completeness
(they match re-exports in the JS reference and may be used by external consumers):

| Module | Item | Reason |
|--------|------|--------|
| `crypto` | `KeyNonce` (re-export) | Exported type, no internal consumer |
| `crypto` | `EAX`, `aes_cmac` (re-exports) | Exported for downstream use |
| `crypto` | `clamp_scalar`, `generate_temporary_key`, `get_shared_secret2`, `sign`, `verify_sign` (re-exports) | Primitives exported for downstream |
| `handshake` | `INIT_VERSION` (re-export) | Published constant |
| `handshake` | `LicenseChain`, `parse_licenses` (re-exports) | Published types/functions |
| `transport` | Packet function camelCase aliases (re-exports) | JS-compatible naming exports |
| `transport` | `GenerationWindow`, `Qlz`, `OnClose`, `OnPacket` (re-exports) | Published types |
| `crypto/crypt` | `KeyNonce::gen` | Stored but not read; same as JS |
| `handshake/license` | `not_valid_before`, `not_valid_after` | Parsed but not read after construction; same as JS |
| `transport/packet` | `parse_c2s_header` | Never called; same as JS |
| `transport/generation_window` | `generation()`, `sync_to()`, `is_future_packet()`, `reset()` | Unused convenience methods; same as JS |

Items marked `#[allow(dead_code)]` or `#[allow(unused_imports)]` in the source.

## Related

- **[teamspeak-js](https://github.com/honeybbq/teamspeak-js)** — The TypeScript reference implementation this library is ported from
- **[teamspeak-go](https://github.com/honeybbq/teamspeak-go)** — The original Go implementation

## Acknowledgments

Protocol knowledge was primarily informed by the [TSLib](https://github.com/Splamy/TS3AudioBot) implementation in [TS3AudioBot](https://github.com/Splamy/TS3AudioBot) by Splamy. Huge thanks to the TS3AudioBot project and its contributors.

## Disclaimer

TeamSpeak is a registered trademark of [TeamSpeak Systems GmbH](https://teamspeak.com/). This project is not affiliated with, endorsed by, or associated with TeamSpeak Systems GmbH in any way.

This library is a **clean-room implementation** developed from publicly available documentation, protocol analysis of network traffic, and independent research. No proprietary TeamSpeak SDK code, headers, or libraries were used in its creation.

## License

[MIT](LICENSE)
