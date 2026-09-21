//! Cron validation for `source` declarations (the planner owns the full
//! recurrence IR; the compiler only refuses what no provider could run).

pub fn validate(cron: &str) -> Result<(), String> {
    let fields: Vec<&str> = cron.split_whitespace().collect();
    if fields.len() != 5 {
        return Err(format!("expected five fields, found {}", fields.len()));
    }
    let ranges = [
        (0u32, 59u32, "minute"),
        (0, 23, "hour"),
        (1, 31, "day-of-month"),
        (1, 12, "month"),
        (0, 7, "day-of-week"),
    ];
    for (text, (min, max, name)) in fields.iter().zip(ranges) {
        if *text == "*" {
            continue;
        }
        for part in text.split(',') {
            let (base, step) = match part.split_once('/') {
                Some((b, s)) => (
                    b,
                    s.parse::<u32>()
                        .map_err(|_| format!("bad step in {name} `{part}`"))?,
                ),
                None => (part, 1),
            };
            let (lo, hi) = if base == "*" {
                (min, max)
            } else if let Some((a, b)) = base.split_once('-') {
                (
                    a.parse::<u32>()
                        .map_err(|_| format!("bad {name} `{part}`"))?,
                    b.parse::<u32>()
                        .map_err(|_| format!("bad {name} `{part}`"))?,
                )
            } else {
                let v = base
                    .parse::<u32>()
                    .map_err(|_| format!("bad {name} `{part}`"))?;
                (v, v)
            };
            if lo < min || hi > max || lo > hi || step == 0 {
                return Err(format!("{name} `{part}` out of range {min}..{max}"));
            }
        }
    }
    Ok(())
}

/// IANA zone names accepted for schedules. `UTC` plus `Area/City` forms; the runtime rejects
/// names its Intl database does not know at build time.
pub fn known_timezone(tz: &str) -> bool {
    tz == "UTC"
        || (tz.contains('/')
            && tz
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '+')))
}
