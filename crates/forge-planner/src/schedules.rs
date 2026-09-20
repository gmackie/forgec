//! Schedules (plan §19): a `source` cron compiles to an explicit recurrence IR
//! (sets, weekday numbering 0..6 with 7 = Sunday, day-of-month/day-of-week OR)
//! and to each provider's trigger. Cloudflare Cron Triggers are UTC-only and
//! EventBridge Scheduler has its own field dialect, so when a provider cannot
//! express the rule exactly the plan falls back to a periodic tick; the
//! runtime ledger decides which intended occurrences are due either way.
use forge_semantic::ir::*;
use serde::Serialize;

pub const SCHEDULES_VERSION: &str = "schedules/1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum FieldSet {
    Any(String),
    Values(Vec<u32>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recurrence {
    pub kind: String,
    pub minutes: Vec<u32>,
    pub hours: Vec<u32>,
    pub days_of_month: FieldSet,
    pub months: FieldSet,
    pub days_of_week: FieldSet,
    pub day_combination: String,
    pub timezone: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulePlan {
    pub source: String,
    pub name: String,
    pub target: String,
    pub recurrence: Recurrence,
    pub cloudflare: CloudflareTrigger,
    pub aws: AwsTrigger,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudflareTrigger {
    /// Exact UTC cron when the schedule is UTC; otherwise the periodic tick carries it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cron: Option<String>,
    pub tick: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsTrigger {
    /// EventBridge Scheduler expression: `cron(...)` with `timezone`, or `rate(5 minutes)` when inexpressible.
    pub expression: String,
    pub timezone: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulesPlan {
    pub version: String,
    pub schedules: Vec<SchedulePlan>,
    /// Every distinct exact UTC cron the Worker must declare (plus the 5-minute tick when any schedule needs it).
    pub cloudflare_crons: Vec<String>,
}

pub fn parse_field(text: &str, min: u32, max: u32, name: &str) -> Result<FieldSet, String> {
    if text == "*" {
        return Ok(FieldSet::Any("any".into()));
    }
    let mut out = std::collections::BTreeSet::new();
    for part in text.split(',') {
        let (base, step) = match part.split_once('/') {
            Some((b, s)) => (b, s.parse::<u32>().map_err(|_| format!("invalid {name} step in `{part}`"))?),
            None => (part, 1),
        };
        let (mut lo, mut hi) = if base == "*" {
            (min, max)
        } else if let Some((a, b)) = base.split_once('-') {
            (a.parse::<u32>().map_err(|_| format!("invalid {name} field `{part}`"))?, b.parse::<u32>().map_err(|_| format!("invalid {name} field `{part}`"))?)
        } else {
            let v = base.parse::<u32>().map_err(|_| format!("invalid {name} field `{part}`"))?;
            (v, if part.contains('/') { max } else { v })
        };
        if name == "day-of-week" {
            if lo == 7 { lo = 0; }
            if hi == 7 { hi = 0; }
        }
        if lo < min || hi > max || step < 1 || lo > hi {
            return Err(format!("{name} value out of range in `{part}`"));
        }
        let mut v = lo;
        while v <= hi {
            out.insert(v);
            v += step;
        }
    }
    Ok(FieldSet::Values(out.into_iter().collect()))
}

pub fn parse_recurrence(cron: &str, timezone: &str) -> Result<Recurrence, String> {
    let fields: Vec<&str> = cron.split_whitespace().collect();
    if fields.len() != 5 {
        return Err(format!("cron expression must have five fields, got {}", fields.len()));
    }
    let expand = |f: FieldSet, min: u32, max: u32| match f {
        FieldSet::Any(_) => (min..=max).collect(),
        FieldSet::Values(v) => v,
    };
    Ok(Recurrence {
        kind: "cron".into(),
        minutes: expand(parse_field(fields[0], 0, 59, "minute")?, 0, 59),
        hours: expand(parse_field(fields[1], 0, 23, "hour")?, 0, 23),
        days_of_month: parse_field(fields[2], 1, 31, "day-of-month")?,
        months: parse_field(fields[3], 1, 12, "month")?,
        days_of_week: parse_field(fields[4], 0, 7, "day-of-week")?,
        day_combination: "or".into(),
        timezone: timezone.into(),
    })
}

fn join(v: &[u32]) -> String {
    v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(",")
}
fn set(f: &FieldSet) -> String {
    match f {
        FieldSet::Any(_) => "*".into(),
        FieldSet::Values(v) => join(v),
    }
}

/// Canonical UTC five-field cron (explicit values, no ranges/steps) for Cloudflare.
fn cloudflare_cron(r: &Recurrence) -> String {
    format!("{} {} {} {} {}", join(&r.minutes), join(&r.hours), set(&r.days_of_month), set(&r.months), set(&r.days_of_week))
}

/// EventBridge Scheduler `cron(min hour dom mon dow year)`: exactly one of dom/dow may be restricted
/// (`?` for the other) and weekdays are 1..7 = SUN..SAT. Anything else needs the tick.
fn aws_cron(r: &Recurrence) -> Option<String> {
    let (dom, dow) = match (&r.days_of_month, &r.days_of_week) {
        (FieldSet::Values(_), FieldSet::Values(_)) => return None,
        (FieldSet::Any(_), FieldSet::Any(_)) => ("*".to_string(), "?".to_string()),
        (FieldSet::Values(d), FieldSet::Any(_)) => (join(d), "?".to_string()),
        (FieldSet::Any(_), FieldSet::Values(w)) => ("?".to_string(), join(&w.iter().map(|x| x + 1).collect::<Vec<_>>())),
    };
    Some(format!("cron({} {} {} {} {} *)", join(&r.minutes), join(&r.hours), dom, set(&r.months), dow))
}

pub const TICK_CRON: &str = "*/5 * * * *";

pub fn plan(ir: &DomainIR) -> SchedulesPlan {
    let mut schedules = Vec::new();
    let mut crons = std::collections::BTreeSet::new();
    let mut tick = false;
    for m in &ir.modules {
        for s in &m.sources {
            let Some(cron) = &s.cron else { continue };
            let tz = s.timezone.clone().unwrap_or_else(|| "UTC".into());
            let Ok(recurrence) = parse_recurrence(cron, &tz) else { continue }; // rejected by the semantic pass
            let cf_cron = if tz == "UTC" { Some(cloudflare_cron(&recurrence)) } else { None };
            let needs_tick = cf_cron.is_none();
            if let Some(c) = &cf_cron {
                crons.insert(c.clone());
            }
            tick |= needs_tick;
            let aws = match aws_cron(&recurrence) {
                Some(e) => AwsTrigger { expression: e, timezone: tz.clone() },
                None => AwsTrigger { expression: "rate(5 minutes)".into(), timezone: tz.clone() },
            };
            schedules.push(SchedulePlan { source: s.id.clone(), name: s.name.clone(), target: s.target.clone(), recurrence, cloudflare: CloudflareTrigger { cron: cf_cron, tick: needs_tick }, aws });
        }
    }
    if tick {
        crons.insert(TICK_CRON.into());
    }
    SchedulesPlan { version: SCHEDULES_VERSION.into(), schedules, cloudflare_crons: crons.into_iter().collect() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sets_are_explicit_and_sunday_is_zero() {
        let r = parse_recurrence("*/15 9-17 * * 1-5", "UTC").unwrap();
        assert_eq!(r.minutes, vec![0, 15, 30, 45]);
        assert_eq!(r.hours, (9..=17).collect::<Vec<_>>());
        assert_eq!(r.days_of_week, FieldSet::Values(vec![1, 2, 3, 4, 5]));
        assert_eq!(parse_recurrence("0 0 1 * 7", "UTC").unwrap().days_of_week, FieldSet::Values(vec![0]));
        assert!(parse_recurrence("0 25 * * *", "UTC").is_err());
        assert!(parse_recurrence("0 3 * *", "UTC").is_err());
    }

    #[test]
    fn provider_lowerings() {
        let r = parse_recurrence("0 3 * * *", "UTC").unwrap();
        assert_eq!(cloudflare_cron(&r), "0 3 * * *");
        assert_eq!(aws_cron(&r).unwrap(), "cron(0 3 * * ? *)");
        let w = parse_recurrence("30 8 * * 1-5", "UTC").unwrap();
        assert_eq!(aws_cron(&w).unwrap(), "cron(30 8 ? * 2,3,4,5,6 *)");
        let both = parse_recurrence("0 0 15 * 1", "UTC").unwrap();
        assert!(aws_cron(&both).is_none(), "dom OR dow is not expressible in EventBridge");
    }
}
