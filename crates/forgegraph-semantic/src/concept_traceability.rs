//! Typed reconstruction obligations and provider-independent observed witnesses.
use crate::concept::{ConceptIR, Field, Violation};
use crate::concept_governance::Applicability;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TraceabilityRequirement {
    pub source: String,
    pub destination: String,
    pub path: Vec<TraceHop>,
    /// ExternalConstraint declaration retaining authority and citation provenance.
    pub required_by: String,
    pub applicability: Applicability,
    pub valid_from: i64,
    pub valid_until: Option<i64>,
    /// Minimum retention after each record's recordedAt, not a storage implementation.
    pub retention_days: Option<u32>,
    pub required_attributes: BTreeMap<String, BTreeSet<String>>,
    pub valid_time: bool,
    pub knowledge_time: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TraceHop {
    pub relationship: String,
    pub from_role: String,
    pub to_role: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TraceRecord {
    pub declaration: String,
    pub attributes: BTreeMap<String, serde_json::Value>,
    pub recorded_at: i64,
    pub retained_until: i64,
    pub valid_time: Option<TraceInterval>,
    pub knowledge_time: Option<TraceInterval>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TraceInterval {
    pub from: i64,
    pub to: Option<i64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TraceWitness {
    pub concept_hash: String,
    pub requirement: String,
    pub at: i64,
    /// Artifact locator only; no truth or authority is inferred from this string.
    pub evidence: String,
    /// Ordered record IDs, one more than the declared hop count.
    pub chain: Vec<String>,
    pub records: BTreeMap<String, TraceRecord>,
    /// Each hop's observed relationship carrier, with explicit role-to-record bindings.
    pub links: Vec<TraceLink>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TraceLink {
    pub relationship: String,
    pub evidence: String,
    pub roles: BTreeMap<String, String>,
}
fn fields<'a>(c: &'a ConceptIR, id: &str) -> Option<&'a BTreeMap<String, Field>> {
    c.entities
        .get(id)
        .map(|e| &e.fields)
        .or_else(|| c.facts.get(id).map(|f| &f.fields))
}
impl ConceptIR {
    pub(crate) fn validate_traceability(&self) -> Vec<Violation> {
        let mut errors = vec![];
        for (id, trace) in &self.semantics.traceability {
            let mut fail = |message: &str| {
                errors.push(Violation {
                    code: "E-L0-TRACEABILITY".into(),
                    subject: id.clone(),
                    message: message.into(),
                })
            };
            if fields(self, &trace.source).is_none() || fields(self, &trace.destination).is_none() {
                fail("trace endpoints must be declared entities or facts");
            }
            if !self
                .semantics
                .external_constraints
                .contains_key(&trace.required_by)
            {
                fail("unknown requiring external constraint");
            }
            if !self.valid_external_applicability(&trace.applicability) {
                fail("trace applicability must be a typed boolean process-context predicate");
            }
            if trace.path.is_empty() {
                fail("trace requires at least one typed relationship hop");
            }
            if trace
                .valid_until
                .is_some_and(|until| until <= trace.valid_from)
            {
                fail("trace validity interval must be nonempty and ordered");
            }
            if trace.retention_days == Some(0) {
                fail("minimum retention must be positive");
            }
            let mut cursor = trace.source.as_str();
            let mut nodes = BTreeSet::from([cursor]);
            for hop in &trace.path {
                let endpoints = self
                    .semantics
                    .relationships
                    .get(&hop.relationship)
                    .and_then(|r| {
                        Some((
                            r.endpoints.get(&hop.from_role)?,
                            r.endpoints.get(&hop.to_role)?,
                        ))
                    });
                match endpoints {
                    Some((from, to)) if from.target == cursor && hop.from_role != hop.to_role => {
                        cursor = &to.target;
                        nodes.insert(cursor);
                    }
                    _ => fail("trace hop must connect distinct roles from the preceding endpoint"),
                }
            }
            if cursor != trace.destination {
                fail("trace path does not reach the declared destination");
            }
            for (target, attributes) in &trace.required_attributes {
                if !nodes.contains(target.as_str())
                    || attributes.is_empty()
                    || !attributes
                        .iter()
                        .all(|a| fields(self, target).is_some_and(|fs| fs.contains_key(a)))
                {
                    fail("required attributes must name declared fields on path endpoints");
                }
            }
            for node in nodes {
                let temporal = self.semantics.temporal.get(node);
                if trace.valid_time && !temporal.is_some_and(|t| t.valid.is_some()) {
                    fail("trace endpoint lacks required valid-time semantics");
                }
                if trace.knowledge_time && !temporal.is_some_and(|t| t.knowledge.is_some()) {
                    fail("trace endpoint lacks required knowledge-time semantics");
                }
            }
        }
        errors
    }
    /// Check supplied reconstruction evidence. Does not evaluate applicability, authenticate
    /// evidence, certify storage completeness, or promise future retention enforcement.
    pub fn check_trace_witness(&self, witness: &TraceWitness) -> Vec<Violation> {
        let mut errors = self.validate_closed();
        let mut fail = |message: &str| {
            errors.push(Violation {
                code: "E-L0-TRACE-WITNESS".into(),
                subject: witness.requirement.clone(),
                message: message.into(),
            })
        };
        if witness.concept_hash != self.content_hash() {
            fail("witness is bound to another ConceptIR");
        }
        if witness.evidence.trim().is_empty() {
            fail("witness requires an evidence locator");
        }
        let Some(trace) = self.semantics.traceability.get(&witness.requirement) else {
            fail("unknown traceability requirement");
            return errors;
        };
        if witness.at < trace.valid_from
            || trace.valid_until.is_some_and(|until| witness.at >= until)
        {
            fail("requirement is not effective at the witness time");
        }
        if witness.chain.len() != trace.path.len() + 1 || witness.links.len() != trace.path.len() {
            fail("witness must cover every declared hop");
            return errors;
        }
        let mut expected = trace.source.as_str();
        for (index, record_id) in witness.chain.iter().enumerate() {
            let Some(record) = witness.records.get(record_id) else {
                fail("missing chain record");
                continue;
            };
            if record_id.trim().is_empty() || record.declaration != expected {
                fail("chain record has the wrong declaration type");
            }
            if trace
                .required_attributes
                .get(expected)
                .is_some_and(|attrs| {
                    attrs.iter().any(|a| {
                        record
                            .attributes
                            .get(a)
                            .is_none_or(serde_json::Value::is_null)
                    })
                })
            {
                fail("chain record lacks required attribute evidence");
            }
            let minimum = i64::from(trace.retention_days.unwrap_or(0)) * 86_400_000;
            if record.recorded_at > witness.at
                || record.retained_until < witness.at
                || record
                    .recorded_at
                    .checked_add(minimum)
                    .is_none_or(|end| record.retained_until < end)
            {
                fail("chain record does not meet observation/retention bounds");
            }
            for (required, interval) in [
                (trace.valid_time, &record.valid_time),
                (trace.knowledge_time, &record.knowledge_time),
            ] {
                if required && interval.is_none()
                    || interval
                        .as_ref()
                        .is_some_and(|i| i.to.is_some_and(|to| to <= i.from))
                {
                    fail("chain record lacks a valid required temporal interval");
                }
            }
            if let Some(hop) = trace.path.get(index) {
                let link = &witness.links[index];
                if link.relationship != hop.relationship
                    || link.evidence.trim().is_empty()
                    || link.roles.get(&hop.from_role) != Some(record_id)
                    || link.roles.get(&hop.to_role) != witness.chain.get(index + 1)
                {
                    fail("relationship evidence does not bind consecutive chain records");
                }
                if let Some(endpoint) = self
                    .semantics
                    .relationships
                    .get(&hop.relationship)
                    .and_then(|r| r.endpoints.get(&hop.to_role))
                {
                    expected = &endpoint.target;
                }
            }
        }
        errors
    }
}
