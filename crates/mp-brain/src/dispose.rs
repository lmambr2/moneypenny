// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Bot-side disposal of brain tool proposals. Never throws — per-tool
//! failures become ok:false records. Rights / dry-run live in the executor.

use serde_json::Value;

use crate::types::{DisposedTool, ToolProposal};

/// Sequential dispose. `execute` returns (ok, result, error) or Err(message).
pub async fn dispose_tool_proposals<F, Fut>(proposals: &[ToolProposal], mut execute: F) -> Vec<DisposedTool>
where
    F: FnMut(String, Value) -> Fut,
    Fut: std::future::Future<Output = Result<(bool, Option<String>, Option<String>), String>>,
{
    let mut out = Vec::with_capacity(proposals.len());
    for p in proposals {
        let name = p.name.trim().to_string();
        let args = if p.arguments.is_object() {
            p.arguments.clone()
        } else {
            serde_json::json!({})
        };
        if name.is_empty() {
            out.push(DisposedTool {
                name: String::new(),
                args,
                ok: false,
                result: None,
                error: Some("empty tool name".into()),
            });
            continue;
        }
        match execute(name.clone(), args.clone()).await {
            Ok((ok, result, error)) => out.push(DisposedTool {
                name,
                args,
                ok,
                result,
                error,
            }),
            Err(msg) => out.push(DisposedTool {
                name,
                args,
                ok: false,
                result: None,
                error: Some(msg),
            }),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn maps_ok_and_fail_without_throwing() {
        let proposals = vec![
            ToolProposal {
                name: "good".into(),
                arguments: serde_json::json!({}),
                reason: None,
            },
            ToolProposal {
                name: "bad".into(),
                arguments: serde_json::json!({"a": 1}),
                reason: None,
            },
        ];
        let out = dispose_tool_proposals(&proposals, |name, _| async move {
            if name == "bad" {
                Err("boom".into())
            } else {
                Ok((true, Some("ok".into()), None))
            }
        })
        .await;
        assert!(out[0].ok);
        assert_eq!(out[0].result.as_deref(), Some("ok"));
        assert!(!out[1].ok);
        assert_eq!(out[1].error.as_deref(), Some("boom"));
    }
}
