<div align="center">

# tsclient-rs

**使用 Rust 编写的 TeamSpeak 3 客户端协议库。**

兼容 TeamSpeak 3、5 和 6。从 [teamspeak-js](https://github.com/honeybbq/teamspeak-js) 移植。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

## 特性

- **完整协议握手** — ECDH 密钥交换、RSA 谜题、EAX 加密传输
- **命令与通知系统** — 发送命令，接收服务器事件
- **事件驱动 API** — 注册文本消息、客户端加入/离开、频道移动、被踢等事件处理
- **语音数据** — 发送 Opus 语音包（codec 4 & 5）
- **文件传输** — 上传、下载、删除服务器文件
- **地址解析** — SRV 记录、TSDNS、直接地址支持
- **中间件** — 可插拔的命令和事件中间件链
- **内置限速器** — 令牌桶算法防止服务器 flood 踢出
- **身份管理** — 生成、导入/导出身份
- **零 unsafe 代码** — 纯安全 Rust，不含 `unsafe` 块
- **异步原生** — 基于 `tokio`，支持正确的异步取消和优雅关闭

## 快速开始

```rust
use std::sync::Arc;
use tsclient_rs::*;

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt().init();

    // 生成身份
    let identity = generateIdentity(8);

    // 创建客户端
    let mut client = Client::new(
        identity,
        "127.0.0.1:9987".to_string(),
        "MyBot".to_string(),
        ClientOptions {
            logger: Arc::new(noopLogger),
            ..Default::default()
        },
    );

    // 注册事件
    client.on_connected(Arc::new(|| println!("已连接")));
    client.on_disconnected(Arc::new(|ev| println!("断开: {:?}", ev)));

    // 连接
    client.connect().await?;
    client.wait_connected(None).await?;
    println!("CLID: {}", client.client_id());

    // 获取列表
    let channels = listChannels(&client).await?;
    let clients = listClients(&client).await?;

    // 优雅断开
    client.disconnect().await?;

    Ok(())
}
```

## API 概览

### 客户端生命周期

| 方法                                          | 说明                              |
| --------------------------------------------- | --------------------------------- |
| `Client::new(identity, addr, name, opts?)`    | 创建新客户端                      |
| `client.connect()`                            | 发起服务器连接                    |
| `client.wait_connected(signal?)`              | 等待握手完成                      |
| `client.disconnect()`                         | 优雅断开（等待后台任务结束）      |
| `client.status()`                             | 获取当前 `ClientStatus`           |
| `client.client_id()`                          | 获取服务器分配的客户端 ID         |
| `client.channel_id()`                         | 获取当前所在频道 ID               |

### 事件

| 方法                                     | 说明                  |
| ---------------------------------------- | --------------------- |
| `client.on_connected(handler)`           | 完全连接时触发        |
| `client.on_disconnected(handler)`        | 断开连接时触发        |
| `client.on_text_message(handler)`        | 收到文本消息时触发    |
| `client.on_client_enter(handler)`        | 客户端加入时触发      |
| `client.on_client_leave(handler)`        | 客户端离开时触发      |
| `client.on_client_moved(handler)`        | 客户端移动频道时触发  |
| `client.on_kicked(handler)`              | 机器人被踢时触发      |
| `client.on_poked(handler)`               | 被戳时触发            |
| `client.on_voice_data(handler)`          | 收到语音数据时触发    |

### 命令

| 函数                                                   | 说明                        |
| ------------------------------------------------------ | --------------------------- |
| `sendTextMessage(client, targetMode, targetId, msg)`   | 发送文本消息                |
| `clientMove(client, clid, channelId, password?)`       | 移动客户端                  |
| `poke(client, clid, message)`                          | 戳客户端                    |
| `client.send_voice(data, codec)`                       | 发送 Opus 语音数据          |
| `listChannels(client)`                                 | 列出所有频道                |
| `listClients(client)`                                  | 列出所有在线客户端          |
| `getClientInfo(client, clid)`                          | 获取客户端详细信息          |
| `client.exec_command(cmd, timeout?)`                   | 执行原始命令                |
| `client.exec_command_with_response(cmd, timeout?)`     | 执行命令并获取响应          |
| `client.send_command_no_wait(cmd)`                     | 发送后不等待响应            |

### 文件传输

| 函数                                       | 说明                  |
| ------------------------------------------ | --------------------- |
| `client.file_transfer_init_upload(...)`    | 初始化文件上传        |
| `client.file_transfer_init_download(...)`  | 初始化文件下载        |
| `fileTransferDeleteFile(client, ...)`      | 删除服务器文件        |
| `uploadFileData(host, info, reader)`       | 上传文件数据          |
| `downloadFileData(host, info, writer)`     | 下载文件数据          |

### 身份管理

```rust
use tsclient_rs::*;

// 生成新身份（安全等级 8）
let identity = generateIdentity(8);

// 导出为字符串以便持久化
let exported = identity.export_string();

// 从字符串恢复
let restored = identityFromString(&exported);

// 从公钥获取 UID
let uid = getUidFromPublicKey(&identity.public_key);
```

### 客户端选项

```rust
let client = Client::new(identity, "ts.example.com", "MyBot", ClientOptions {
    logger: Arc::new(consoleLogger),
    resolver: None,
    command_middleware: vec![],
    event_middleware: vec![],
    server_password: Some("密码".into()),
    default_channel: Some("大厅".into()),
    default_channel_password: Some("".into()),
});
```

## 中间件

```rust
use tsclient_rs::*;

// 记录所有发出的命令
struct LogMiddleware;

impl CommandMiddleware for LogMiddleware {
    fn wrap(&self, next: CommandHandler) -> CommandHandler {
        Arc::new(move |cmd: String| {
            println!(">> 发送命令: {cmd}");
            let next = next.clone();
            Box::pin(async move { next(cmd).await })
        })
    }
}

client.use_command_middleware(vec![Box::new(LogMiddleware)]);

// 过滤私聊消息
struct DropPrivateMessages;

impl EventMiddleware for DropPrivateMessages {
    fn wrap(&self, next: EventHandler) -> EventHandler {
        Arc::new(move |ev: Event| {
            if let Event::TextMessage(ref msg) = ev {
                if msg.target_mode == 1 { return; } // 丢弃私聊
            }
            next(ev)
        })
    }
}

client.use_event_middleware(vec![Box::new(DropPrivateMessages)]);
```

## 自定义日志

```rust
use std::fmt::Display;
use tsclient_rs::*;

struct MyLogger;
impl Logger for MyLogger {
    fn debug(&self, msg: &str, _args: &[&dyn Display]) { eprintln!("[DEBUG] {msg}"); }
    fn info(&self, msg: &str, _args: &[&dyn Display])  { eprintln!("[INFO] {msg}"); }
    fn warn(&self, msg: &str, _args: &[&dyn Display])  { eprintln!("[WARN] {msg}"); }
    fn error(&self, msg: &str, _args: &[&dyn Display]) { eprintln!("[ERROR] {msg}"); }
}

Client::new(identity, addr, nickname, ClientOptions {
    logger: Arc::new(MyLogger),
    ..Default::default()
});
```

## 项目结构

```
tsclient-rs/
├── src/
│   ├── client.rs          # 客户端生命周期、连接管理
│   ├── api.rs             # 高层 API（消息、频道、客户端）
│   ├── commands.rs        # 命令发送与响应追踪
│   ├── events.rs          # 事件注册与中间件
│   ├── notifications.rs   # 服务器通知解析与分发
│   ├── handshake.rs       # 协议握手编排
│   ├── transfer.rs        # 文件传输操作
│   ├── throttle.rs        # 令牌桶限速器
│   ├── types.rs           # 公开类型定义
│   ├── errors.rs          # 错误类型
│   ├── crypto/            # ECDH、EAX 加密、身份管理
│   ├── handshake/         # 加密握手与许可证验证
│   ├── transport/         # UDP 包封装、ACK、压缩
│   ├── command/           # 命令构建与解析
│   └── discovery/         # SRV / TSDNS / 地址解析
├── test_tsclient/         # 集成测试客户端
│   └── src/main.rs
├── teamspeak-js/          # 原始 JS 参考实现（子模块）
├── teamspeak-music-bot/   # 基于 teamspeak-js 的音乐机器人（子模块）
├── Cargo.toml
└── LICENSE
```

## 依赖配置

```toml
[dependencies]
tsclient-rs = { git = "https://github.com/anomalyco/tsclient-rs" }
tokio = { version = "1", features = ["rt", "macros", "net", "time"] }
tracing = "0.1"
```

使用 `current_thread` runtime（不启用 `rt-multi-thread`）时，`disconnect()` 会等待所有后台任务结束后再返回，确保干净退出。

## 已知死代码

以下项未使用但保留以保持 API 完整性（与 JS 参考实现的导出方式一致）：

| 模块 | 项 | 原因 |
|--------|------|------|
| `crypto` | `KeyNonce`（再导出） | 导出的类型，无内部使用者 |
| `crypto` | `EAX`, `aes_cmac`（再导出） | 为下游使用者导出 |
| `crypto` | `clamp_scalar`, `generate_temporary_key`, `get_shared_secret2`, `sign`, `verify_sign`（再导出） | 为下游导出原语 |
| `handshake` | `INIT_VERSION`（再导出） | 公开常量 |
| `handshake` | `LicenseChain`, `parse_licenses`（再导出） | 公开类型与函数 |
| `transport` | 包函数 camelCase 别名（再导出） | 兼容 JS 命名的导出 |
| `transport` | `GenerationWindow`, `Qlz`, `OnClose`, `OnPacket`（再导出） | 公开类型 |
| `crypto/crypt` | `KeyNonce::gen` | 存储但未读取；与 JS 相同 |
| `handshake/license` | `not_valid_before`, `not_valid_after` | 解析后未再读取；与 JS 相同 |
| `transport/packet` | `parse_c2s_header` | 从未被调用；与 JS 相同 |
| `transport/generation_window` | `generation()`, `sync_to()`, `is_future_packet()`, `reset()` | 便捷方法未使用；与 JS 相同 |

源码中标记为 `#[allow(dead_code)]` 或 `#[allow(unused_imports)]`。

## 相关项目

- **[teamspeak-js](https://github.com/honeybbq/teamspeak-js)** — 此库移植自的 TypeScript 参考实现
- **[teamspeak-go](https://github.com/honeybbq/teamspeak-go)** — 原始 Go 语言实现

## 致谢

协议知识主要参考了 [TS3AudioBot](https://github.com/Splamy/TS3AudioBot) 中的 [TSLib](https://github.com/Splamy/TS3AudioBot) 实现。感谢 TS3AudioBot 项目及其贡献者。

## 免责声明

TeamSpeak 是 [TeamSpeak Systems GmbH](https://teamspeak.com/) 的注册商标。本项目与 TeamSpeak Systems GmbH 无任何关联、认可或合作关系。

此库是基于公开文档、网络流量协议分析和独立研究开发的**净室实现**。未使用任何专有的 TeamSpeak SDK 代码、头文件或库。

## 许可证

[MIT](LICENSE)
