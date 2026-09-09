//! Server notification parsing & dispatch — mirrors `teamspeak-js/src/notifications.ts`

use std::collections::HashMap;

use crate::command::unescape;
use crate::helpers::{parse_i10, parse_u16, parse_u64};
use crate::types::*;

#[derive(Debug, Clone)]
pub enum NotificationResult {
    ClientEnter { info: ClientInfo },
    ClientLeave { event: ClientLeftViewEvent, is_self: bool },
    ClientMoved { event: ClientMovedEvent },
    TextMessage { message: TextMessage },
    Poked { event: PokeEvent },
    StartUpload { info: FileUploadInfo },
    StartDownload { info: FileDownloadInfo },
    FileTransferStatus { info: FileTransferStatusInfo },
    Unknown,
}

/// Parse a `notify*` command into a [`NotificationResult`].
pub fn handle_notification(
    cmd_name: &str,
    params: &HashMap<String, String>,
    self_clid: i32,
    clients: &mut HashMap<i32, ClientInfo>,
    nickname: &str,
) -> NotificationResult {
    match cmd_name {
        "notifycliententerview" => handle_client_enter_view(params, clients, nickname),
        "notifyclientleftview" => handle_client_left_view(params, self_clid, clients),
        "notifyclientmoved" => handle_client_moved(params, clients),
        "notifytextmessage" => handle_text_message(params, clients),
        "notifyclientpoke" => handle_client_poked(params),
        "notifystartupload" => {
            let info = handle_start_upload(params);
            NotificationResult::StartUpload { info }
        }
        "notifystartdownload" => {
            let info = handle_start_download(params);
            NotificationResult::StartDownload { info }
        }
        "notifystatusfiletransfer" => {
            let info = handle_file_transfer_status(params);
            NotificationResult::FileTransferStatus { info }
        }
        _ => NotificationResult::Unknown,
    }
}

fn handle_client_enter_view(
    params: &HashMap<String, String>,
    clients: &mut HashMap<i32, ClientInfo>,
    _nickname: &str,
) -> NotificationResult {
    let clid = parse_u16(params.get("clid").map(|s| s.as_str()).unwrap_or(""));
    let cid = parse_u64(params.get("cid").map(|s| s.as_str()).unwrap_or(""));
    let client_type = parse_i10(params.get("client_type").map(|s| s.as_str()).unwrap_or(""));
    let groups_str = params.get("client_servergroups").cloned().unwrap_or_default();

    let info = ClientInfo {
        id: clid,
        nickname: params.get("client_nickname").cloned().unwrap_or_default(),
        uid: params.get("client_unique_identifier").cloned().unwrap_or_default(),
        channel_id: cid,
        r#type: client_type,
        server_groups: if groups_str.is_empty() {
            Vec::new()
        } else {
            groups_str.split(',').map(|s| s.to_string()).collect()
        },
    };

    if clid != 0 {
        clients.insert(clid, info.clone());
    }

    NotificationResult::ClientEnter { info }
}

fn handle_client_left_view(
    params: &HashMap<String, String>,
    self_clid: i32,
    clients: &mut HashMap<i32, ClientInfo>,
) -> NotificationResult {
    let clid = parse_u16(params.get("clid").map(|s| s.as_str()).unwrap_or(""));
    let reason_id = parse_i10(params.get("reasonid").map(|s| s.as_str()).unwrap_or(""));

    let is_self = clid == self_clid;
    if clid != 0 {
        clients.remove(&clid);
    }

    let event = ClientLeftViewEvent {
        id: clid,
        reason_id,
        reason_msg: params.get("reasonmsg").cloned().unwrap_or_default(),
        target_id: parse_u16(params.get("targetid").map(|s| s.as_str()).unwrap_or("")),
    };

    NotificationResult::ClientLeave { event, is_self }
}

fn handle_client_moved(
    params: &HashMap<String, String>,
    clients: &mut HashMap<i32, ClientInfo>,
) -> NotificationResult {
    let clid = parse_u16(params.get("clid").map(|s| s.as_str()).unwrap_or(""));
    let ctid = parse_u64(params.get("ctid").map(|s| s.as_str()).unwrap_or(""));

    if clid != 0 {
        if let Some(existing) = clients.get(&clid) {
            let mut updated = existing.clone();
            updated.channel_id = ctid;
            clients.insert(clid, updated);
        }
    }

    NotificationResult::ClientMoved {
        event: ClientMovedEvent {
            id: clid,
            target_channel_id: ctid,
            reason_id: parse_i10(params.get("reasonid").map(|s| s.as_str()).unwrap_or("")),
            invoker_id: parse_u16(params.get("invokerid").map(|s| s.as_str()).unwrap_or("")),
            invoker_name: params.get("invokername").cloned().unwrap_or_default(),
            invoker_uid: params.get("invokeruid").cloned().unwrap_or_default(),
        },
    }
}

fn handle_text_message(
    params: &HashMap<String, String>,
    clients: &mut HashMap<i32, ClientInfo>,
) -> NotificationResult {
    let invoker_id = parse_u16(params.get("invokerid").map(|s| s.as_str()).unwrap_or(""));
    let invoker_info = clients.get(&invoker_id).cloned();

    let message = TextMessage {
        target_mode: parse_i10(params.get("targetmode").map(|s| s.as_str()).unwrap_or("")),
        target_id: parse_u64(params.get("target").map(|s| s.as_str()).unwrap_or("")),
        invoker_id,
        invoker_name: params.get("invokername").cloned().unwrap_or_default(),
        invoker_uid: params
            .get("invokeruid")
            .cloned()
            .or_else(|| invoker_info.as_ref().map(|i| i.uid.clone()))
            .unwrap_or_default(),
        message: unescape(params.get("msg").map(|s| s.as_str()).unwrap_or("")),
        invoker_groups: invoker_info
            .map(|i| i.server_groups)
            .unwrap_or_default(),
    };

    NotificationResult::TextMessage { message }
}

fn handle_start_upload(params: &HashMap<String, String>) -> FileUploadInfo {
    FileUploadInfo {
        client_file_transfer_id: parse_u16(
            params.get("clientftfid").map(|s| s.as_str()).unwrap_or(""),
        ),
        server_file_transfer_id: parse_u16(
            params.get("serverftfid").map(|s| s.as_str()).unwrap_or(""),
        ),
        file_transfer_key: params.get("ftkey").cloned().unwrap_or_default(),
        port: parse_u16(params.get("port").map(|s| s.as_str()).unwrap_or("")),
        seek_position: parse_u64(params.get("seekpos").map(|s| s.as_str()).unwrap_or("")),
    }
}

fn handle_start_download(params: &HashMap<String, String>) -> FileDownloadInfo {
    FileDownloadInfo {
        client_file_transfer_id: parse_u16(
            params.get("clientftfid").map(|s| s.as_str()).unwrap_or(""),
        ),
        server_file_transfer_id: parse_u16(
            params.get("serverftfid").map(|s| s.as_str()).unwrap_or(""),
        ),
        file_transfer_key: params.get("ftkey").cloned().unwrap_or_default(),
        port: parse_u16(params.get("port").map(|s| s.as_str()).unwrap_or("")),
        size: parse_u64(params.get("size").map(|s| s.as_str()).unwrap_or("")),
    }
}

fn handle_file_transfer_status(params: &HashMap<String, String>) -> FileTransferStatusInfo {
    FileTransferStatusInfo {
        client_file_transfer_id: parse_u16(
            params.get("clientftfid").map(|s| s.as_str()).unwrap_or(""),
        ),
        status: parse_i10(params.get("status").map(|s| s.as_str()).unwrap_or("")),
        message: params.get("msg").cloned().unwrap_or_default(),
    }
}

fn handle_client_poked(params: &HashMap<String, String>) -> NotificationResult {
    NotificationResult::Poked {
        event: PokeEvent {
            invoker_id: parse_u16(params.get("invokerid").map(|s| s.as_str()).unwrap_or("")),
            invoker_name: unescape(params.get("invokername").map(|s| s.as_str()).unwrap_or("")),
            invoker_uid: params.get("invokeruid").cloned().unwrap_or_default(),
            message: unescape(params.get("msg").map(|s| s.as_str()).unwrap_or("")),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_params(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn test_client_enter_view() {
        let mut clients = HashMap::new();
        let params = make_params(&[
            ("clid", "42"),
            ("cid", "100"),
            ("client_nickname", "testuser"),
            ("client_unique_identifier", "abc123"),
            ("client_type", "0"),
            ("client_servergroups", "1,2,3"),
        ]);
        let result = handle_client_enter_view(&params, &mut clients, "testuser");
        match result {
            NotificationResult::ClientEnter { info } => {
                assert_eq!(info.id, 42);
                assert_eq!(info.nickname, "testuser");
                assert_eq!(info.server_groups, vec!["1", "2", "3"]);
                assert!(clients.contains_key(&42));
            }
            _ => panic!("expected ClientEnter"),
        }
    }

    #[test]
    fn test_client_left_view() {
        let mut clients = HashMap::new();
        clients.insert(42, ClientInfo {
            id: 42,
            nickname: "testuser".into(),
            uid: "abc".into(),
            server_groups: vec![],
            channel_id: 100,
            r#type: 0,
        });
        let params = make_params(&[
            ("clid", "42"),
            ("reasonid", "1"),
            ("reasonmsg", "left"),
        ]);
        let result = handle_client_left_view(&params, 99, &mut clients);
        match result {
            NotificationResult::ClientLeave { event, is_self } => {
                assert_eq!(event.id, 42);
                assert!(!is_self);
                assert!(!clients.contains_key(&42));
            }
            _ => panic!("expected ClientLeave"),
        }
    }

    #[test]
    fn test_text_message() {
        let mut clients = HashMap::new();
        clients.insert(10, ClientInfo {
            id: 10,
            nickname: "sender".into(),
            uid: "uid123".into(),
            server_groups: vec!["1".into()],
            channel_id: 0,
            r#type: 0,
        });
        let params = make_params(&[
            ("invokerid", "10"),
            ("invokername", "sender"),
            ("targetmode", "1"),
            ("target", "42"),
            ("msg", "hello"),
        ]);
        let result = handle_text_message(&params, &mut clients);
        match result {
            NotificationResult::TextMessage { message } => {
                assert_eq!(message.invoker_name, "sender");
                assert_eq!(message.message, "hello");
                assert_eq!(message.invoker_groups, vec!["1"]);
            }
            _ => panic!("expected TextMessage"),
        }
    }
}
