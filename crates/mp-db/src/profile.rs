// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! TeamSpeak profile toggles stored on `bot_instances`. Node `ProfileConfig` names.

use serde_json::{json, Value};

use crate::{Database, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileConfig {
    pub avatar_enabled: bool,
    pub description_enabled: bool,
    pub nickname_enabled: bool,
    pub away_status_enabled: bool,
    pub channel_desc_enabled: bool,
    pub now_playing_msg_enabled: bool,
}

impl Default for ProfileConfig {
    fn default() -> Self {
        Self {
            avatar_enabled: true,
            description_enabled: true,
            nickname_enabled: true,
            away_status_enabled: true,
            channel_desc_enabled: true,
            now_playing_msg_enabled: true,
        }
    }
}

impl ProfileConfig {
    pub fn to_json(&self) -> Value {
        json!({
            "avatarEnabled": self.avatar_enabled,
            "descriptionEnabled": self.description_enabled,
            "nicknameEnabled": self.nickname_enabled,
            "awayStatusEnabled": self.away_status_enabled,
            "channelDescEnabled": self.channel_desc_enabled,
            "nowPlayingMsgEnabled": self.now_playing_msg_enabled,
        })
    }

    pub fn apply_patch(&mut self, body: &Value) {
        let flag = |key: &str, cur: &mut bool| {
            if let Some(v) = body.get(key).and_then(|v| v.as_bool()) {
                *cur = v;
            }
        };
        flag("avatarEnabled", &mut self.avatar_enabled);
        flag("descriptionEnabled", &mut self.description_enabled);
        flag("nicknameEnabled", &mut self.nickname_enabled);
        flag("awayStatusEnabled", &mut self.away_status_enabled);
        flag("channelDescEnabled", &mut self.channel_desc_enabled);
        flag("nowPlayingMsgEnabled", &mut self.now_playing_msg_enabled);
    }
}

pub struct ProfileStore<'a> {
    db: &'a Database,
}

impl ProfileStore<'_> {
    pub fn new(db: &Database) -> ProfileStore<'_> {
        ProfileStore { db }
    }

    pub fn get(&self, bot_id: &str) -> Result<ProfileConfig> {
        self.db.with_conn(|conn| {
            let row = conn.query_row(
                "SELECT profile_avatar_enabled, profile_description_enabled, profile_nickname_enabled,
                        profile_away_enabled, profile_channel_desc_enabled, profile_now_playing_enabled
                 FROM bot_instances WHERE id=?1",
                rusqlite::params![bot_id],
                |r| {
                    Ok(ProfileConfig {
                        avatar_enabled: r.get::<_, i64>(0)? != 0,
                        description_enabled: r.get::<_, i64>(1)? != 0,
                        nickname_enabled: r.get::<_, i64>(2)? != 0,
                        away_status_enabled: r.get::<_, i64>(3)? != 0,
                        channel_desc_enabled: r.get::<_, i64>(4)? != 0,
                        now_playing_msg_enabled: r.get::<_, i64>(5)? != 0,
                    })
                },
            );
            match row {
                Ok(cfg) => Ok(cfg),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(ProfileConfig::default()),
                Err(e) => Err(e.into()),
            }
        })
    }

    pub fn save(&self, bot_id: &str, cfg: &ProfileConfig) -> Result<ProfileConfig> {
        let b = |v: bool| if v { 1 } else { 0 };
        self.db.with_conn(|conn| {
            let n = conn.execute(
                "UPDATE bot_instances SET
                    profile_avatar_enabled=?1, profile_description_enabled=?2,
                    profile_nickname_enabled=?3, profile_away_enabled=?4,
                    profile_channel_desc_enabled=?5, profile_now_playing_enabled=?6
                 WHERE id=?7",
                rusqlite::params![
                    b(cfg.avatar_enabled),
                    b(cfg.description_enabled),
                    b(cfg.nickname_enabled),
                    b(cfg.away_status_enabled),
                    b(cfg.channel_desc_enabled),
                    b(cfg.now_playing_msg_enabled),
                    bot_id,
                ],
            )?;
            if n == 0 {
                conn.execute(
                    "INSERT INTO bot_instances (
                        id, name, serverAddress, serverPort, nickname, defaultChannel, channelPassword,
                        profile_avatar_enabled, profile_description_enabled, profile_nickname_enabled,
                        profile_away_enabled, profile_channel_desc_enabled, profile_now_playing_enabled
                     ) VALUES (?1, 'Moneypenny', '', 0, 'Moneypenny', '', '', ?2, ?3, ?4, ?5, ?6, ?7)",
                    rusqlite::params![
                        bot_id,
                        b(cfg.avatar_enabled),
                        b(cfg.description_enabled),
                        b(cfg.nickname_enabled),
                        b(cfg.away_status_enabled),
                        b(cfg.channel_desc_enabled),
                        b(cfg.now_playing_msg_enabled),
                    ],
                )?;
            }
            Ok(())
        })?;
        self.get(bot_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Database;
    use serde_json::json;

    #[test]
    fn put_roundtrips_node_field_names() {
        let db = Database::open_in_memory().unwrap();
        let mut cfg = ProfileConfig::default();
        cfg.apply_patch(&json!({"awayStatusEnabled": false, "nowPlayingMsgEnabled": false}));
        let saved = db.profile().save("bot-1", &cfg).unwrap();
        let v = saved.to_json();
        assert_eq!(v["awayStatusEnabled"], false);
        assert_eq!(v["nowPlayingMsgEnabled"], false);
        assert_eq!(v["avatarEnabled"], true);
        let again = db.profile().get("bot-1").unwrap();
        assert!(!again.away_status_enabled);
    }
}
