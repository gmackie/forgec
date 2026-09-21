//! Realtime profile (plan §19): channels bound with `@websocket(path)` fan
//! their messages out to authenticated WebSocket sessions. The logical
//! contract is shared (text JSON frames, capped size, per-stream sequence
//! numbers, bounded replay on resume, at-least-once); the transport differs:
//! a Durable Object per (tenant, channel) on Cloudflare, an API Gateway
//! WebSocket API plus a connection registry on AWS.
use crate::messaging::pkg_slug;
use forge_semantic::ir::*;
use serde::Serialize;

pub const REALTIME_VERSION: &str = "realtime/1";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimePlan {
    pub version: String,
    /// Shared wire profile every adapter must honor.
    pub profile: Profile,
    pub streams: Vec<StreamPlan>,
    pub cloudflare: CloudflareRealtime,
    pub aws: AwsRealtime,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub frame: String,
    pub max_frame_bytes: u32,
    pub replay_depth: u32,
    pub delivery: String,
    pub heartbeat_seconds: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamPlan {
    pub channel: String,
    pub name: String,
    /// WebSocket upgrade path (Cloudflare) / `stream` query value (AWS single endpoint).
    pub path: String,
    pub messages: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudflareRealtime {
    pub binding: String,
    pub class_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsRealtime {
    pub api_name: String,
    pub routes: Vec<String>,
}

pub fn plan(ir: &DomainIR) -> RealtimePlan {
    let slug = pkg_slug(&ir.package.name);
    let mut streams = Vec::new();
    for m in &ir.modules {
        for c in &m.channels {
            if let Some(ws) = &c.websocket {
                streams.push(StreamPlan {
                    channel: c.id.clone(),
                    name: c.name.clone(),
                    path: ws.path.clone(),
                    messages: c.messages.iter().map(|x| x.name.clone()).collect(),
                });
            }
        }
    }
    RealtimePlan {
        version: REALTIME_VERSION.into(),
        profile: Profile {
            frame: "text/json".into(),
            max_frame_bytes: 65_536,
            replay_depth: 256,
            delivery: "at-least-once".into(),
            heartbeat_seconds: 30,
        },
        streams,
        cloudflare: CloudflareRealtime {
            binding: "REALTIME".into(),
            class_name: "ForgeRealtime".into(),
        },
        aws: AwsRealtime {
            api_name: format!("forge-{slug}-realtime"),
            routes: vec!["$connect".into(), "$disconnect".into(), "$default".into()],
        },
    }
}
