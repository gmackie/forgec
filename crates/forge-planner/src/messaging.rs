//! MessagingIR (plan §14): channels (declared + implicit change channels),
//! logical subscriptions (each with its own durable queue), and the send
//! permissions of every function.

use forge_semantic::ir::*;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagingPlan {
    pub version: String,
    pub channels: Vec<ChannelPlan>,
    pub subscriptions: Vec<SubscriptionPlan>,
    pub senders: Vec<SenderPlan>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelPlan {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contract: Option<String>,
    pub distribution: String,
    pub delivery: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
    /// True for `<Resource>.changes` channels synthesized for audited resources.
    pub implicit: bool,
    pub messages: Vec<MessagePlan>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePlan {
    pub name: String,
    pub fields: Vec<Field>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionPlan {
    /// Stable logical name: kebab-case of the handler symbol.
    pub name: String,
    pub channel: String,
    pub message: String,
    pub handler: String,
    /// Deterministic physical queue name (one queue per logical subscription, plan §14).
    pub queue: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SenderPlan {
    pub function: String,
    pub sends: Vec<(String, String)>,
}

use crate::naming::kebab;

pub(crate) fn pkg_slug(name: &str) -> String {
    name.trim_start_matches('@').replace('/', "-").replace('_', "-")
}

pub fn plan(ir: &DomainIR) -> MessagingPlan {
    let mut channels = Vec::new();
    let mut subscriptions = Vec::new();
    let mut senders = Vec::new();
    let slug = pkg_slug(&ir.package.name);
    for m in &ir.modules {
        for c in &m.channels {
            channels.push(ChannelPlan { id: c.id.clone(), name: c.name.clone(), contract: c.contract.clone(), distribution: c.distribution.clone(), delivery: c.delivery.clone(), direction: c.direction.clone(), implicit: false, messages: c.messages.iter().map(|x| MessagePlan { name: x.name.clone(), fields: x.fields.clone() }).collect() });
        }
        for r in &m.resources {
            if r.decorators.audited {
                let id_field = |n: &str, ty: &str| Field { name: n.into(), ty: TypeSpec { base: TypeBase::Scalar { name: ty.into(), args: vec![] }, optional: false, normalizers: vec![], constraints: vec![], purpose: None, data_class: None }, default: None, derived: None, immutable: true, server_owned: true, synthesized: true, hidden: false, doc: None };
                let fields = vec![Field { name: "id".into(), ty: TypeSpec { base: TypeBase::Reference { resource: r.id.clone() }, optional: false, normalizers: vec![], constraints: vec![], purpose: None, data_class: None }, default: None, derived: None, immutable: true, server_owned: true, synthesized: true, hidden: false, doc: None }, id_field("version", "integer")];
                let mut messages: Vec<MessagePlan> = ["Created", "Updated", "Deleted", "Restored"].iter().map(|n| MessagePlan { name: (*n).into(), fields: fields.clone() }).collect();
                if r.lifecycle.is_some() {
                    let mut f = fields.clone();
                    f.push(id_field("action", "text"));
                    f.push(id_field("status", "text"));
                    messages.push(MessagePlan { name: "Transitioned".into(), fields: f });
                }
                channels.push(ChannelPlan { id: format!("{}.changes", r.id), name: format!("{}.changes", r.name), contract: None, distribution: "broadcast".into(), delivery: "at-least-once".into(), direction: None, implicit: true, messages });
            }
        }
        for s in &m.subscriptions {
            let handler_name = s.handler.rsplit('/').next().unwrap_or(&s.handler);
            let name = kebab(handler_name);
            subscriptions.push(SubscriptionPlan { name: name.clone(), channel: s.channel.clone(), message: s.message.clone(), handler: s.handler.clone(), queue: format!("forge-{slug}-{name}") });
        }
        for f in &m.functions {
            if !f.sends.is_empty() {
                senders.push(SenderPlan { function: f.id.clone(), sends: f.sends.iter().map(|x| (x.channel.clone(), x.message.clone())).collect() });
            }
        }
    }
    channels.sort_by(|a, b| a.id.cmp(&b.id));
    subscriptions.sort_by(|a, b| a.name.cmp(&b.name));
    senders.sort_by(|a, b| a.function.cmp(&b.function));
    MessagingPlan { version: "messaging/1".into(), channels, subscriptions, senders }
}
