// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

use mp_rights::{RightsEngine, Scope, Subject};

pub const DOCTRINE_LEVELS: &[&str] = &["unclassified", "restricted", "confidential", "secret"];

/// `unclassified` is always readable; higher levels need `doctrine:<level>`.
pub fn allowed_classifications_for(engine: Option<&RightsEngine>, subject: &Subject) -> Vec<String> {
    let mut out = vec!["unclassified".into()];
    let Some(engine) = engine else {
        return out;
    };
    for level in &["restricted", "confidential", "secret"] {
        if engine.can(subject, &format!("doctrine:{level}"), Scope::Chat) {
            out.push((*level).to_string());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use mp_rights::default_rights_config;

    #[test]
    fn unclassified_always() {
        let s = Subject {
            uid: "m".into(),
            server_groups: vec![],
            nickname: None,
        };
        let e = RightsEngine::new(default_rights_config::<_, _, &str, &str>(
            ["play"],
            ["stop"],
            &[],
        ));
        let a = allowed_classifications_for(Some(&e), &s);
        assert_eq!(a, vec!["unclassified".to_string()]);
    }
}
