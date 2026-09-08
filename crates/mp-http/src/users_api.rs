// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! `/api/users` — list/create/delete/role/reset-password. Admin only.

use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::authz::AdminUser;
use crate::session::{extract_session_token, valid_password, valid_username};
use crate::AppState;
use mp_db::UserRole;

pub async fn users_list(State(st): State<AppState>, _admin: AdminUser) -> Json<Value> {
    let users = st
        .db
        .users()
        .list_users()
        .unwrap_or_default()
        .into_iter()
        .map(|u| {
            json!({
                "id": u.id,
                "username": u.username,
                "role": u.role.as_str(),
                "createdAt": u.created_at,
            })
        })
        .collect::<Vec<_>>();
    Json(json!({ "users": users }))
}

#[derive(Deserialize)]
pub struct CreateBody {
    username: String,
    password: String,
    role: Option<String>,
}

pub async fn users_create(
    State(st): State<AppState>,
    admin: AdminUser,
    Json(body): Json<CreateBody>,
) -> Response {
    if !valid_username(&body.username) || !valid_password(&body.password) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid username or password"})),
        )
            .into_response();
    }
    let role = if body.role.as_deref() == Some("admin") {
        UserRole::Admin
    } else {
        UserRole::Member
    };
    match st
        .db
        .users()
        .create_user(&body.username, &body.password, role)
    {
        Ok(u) => {
            st.db.audit().record(
                Some(&admin.0.id),
                Some(&admin.0.username),
                Some(&u.id),
                Some(&u.username),
                "user.created",
            );
            (
                StatusCode::CREATED,
                Json(json!({
                    "id": u.id,
                    "username": u.username,
                    "role": u.role.as_str(),
                })),
            )
                .into_response()
        }
        Err(e) if e.to_string().contains("username taken") => {
            (StatusCode::CONFLICT, Json(json!({"error":"username taken"}))).into_response()
        }
        Err(e) => {
            tracing::error!(error = %e, "create user");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error":"internal error","code":"INTERNAL_ERROR"})),
            )
                .into_response()
        }
    }
}

pub async fn users_delete(
    State(st): State<AppState>,
    admin: AdminUser,
    Path(id): Path<String>,
) -> Response {
    if id == admin.0.id {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"cannot delete self"})),
        )
            .into_response();
    }
    let Some(target) = st.db.users().find_by_id(&id).ok().flatten() else {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"not found"}))).into_response();
    };
    match st.db.users().delete_if_not_last_admin(&id) {
        Ok("would_orphan") => (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"cannot delete last admin"})),
        )
            .into_response(),
        Ok("ok") => {
            let _ = st.db.sessions().delete_all_for_user(&id, None);
            st.db.audit().record(
                Some(&admin.0.id),
                Some(&admin.0.username),
                Some(&target.id),
                Some(&target.username),
                "user.deleted",
            );
            StatusCode::NO_CONTENT.into_response()
        }
        _ => (StatusCode::NOT_FOUND, Json(json!({"error":"not found"}))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct RoleBody {
    role: String,
}

pub async fn users_role(
    State(st): State<AppState>,
    admin: AdminUser,
    Path(id): Path<String>,
    Json(body): Json<RoleBody>,
) -> Response {
    let new_role = match body.role.as_str() {
        "admin" => UserRole::Admin,
        "member" => UserRole::Member,
        _ => {
            return (StatusCode::BAD_REQUEST, Json(json!({"error":"invalid role"})))
                .into_response();
        }
    };
    let Some(before) = st.db.users().find_by_id(&id).ok().flatten() else {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"not found"}))).into_response();
    };
    match st.db.users().set_role_if_not_last_admin(&id, new_role) {
        Ok("would_orphan") => (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"cannot demote last admin"})),
        )
            .into_response(),
        Ok("ok") => {
            if before.role != new_role {
                st.db.audit().record(
                    Some(&admin.0.id),
                    Some(&admin.0.username),
                    Some(&before.id),
                    Some(&before.username),
                    "user.role_changed",
                );
            }
            StatusCode::NO_CONTENT.into_response()
        }
        _ => (StatusCode::NOT_FOUND, Json(json!({"error":"not found"}))).into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetBody {
    new_password: String,
}

pub async fn users_reset_password(
    State(st): State<AppState>,
    admin: AdminUser,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
    Json(body): Json<ResetBody>,
) -> Response {
    if !valid_password(&body.new_password) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid password"})),
        )
            .into_response();
    }
    let Some(target) = st.db.users().find_by_id(&id).ok().flatten() else {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"not found"}))).into_response();
    };
    if let Err(e) = st.db.users().change_password(&id, &body.new_password) {
        tracing::error!(error = %e, "reset password");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error":"internal error","code":"INTERNAL_ERROR"})),
        )
            .into_response();
    }
    let except = if id == admin.0.id {
        extract_session_token(headers.get(header::COOKIE))
    } else {
        None
    };
    let _ = st
        .db
        .sessions()
        .delete_all_for_user(&id, except.as_deref());
    st.db.audit().record(
        Some(&admin.0.id),
        Some(&admin.0.username),
        Some(&target.id),
        Some(&target.username),
        "user.password_reset",
    );
    StatusCode::NO_CONTENT.into_response()
}
