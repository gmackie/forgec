# Campaign / Outreach

Campaign binds an objective, reusable pinned audience selector, channel policy,
Artifact revision and/or immutable Offer, schedule, optional FundingEnvelope and
Measurement subject. It is separate from a notification. The audience definition
is reusable; a wave is a bounded selection of 1–16 existing notification candidates,
not a replacement for that definition.

`Campaigns.state/act` uses a consecutive, unique 128-event lifecycle journal:
activate, pause, resume, admit wave, close. A stale head loses concurrent admission.
Closing is terminal. Pausing prevents new waves, but does not cancel admitted work.
`wave` requires admission, a complete member set, matching topic/content/channel,
pinned enabled preferences, active participation and evidenced route validity.
An optional Scheduling appointment must be committed, live, and cover the wave.
Budget state consumes published ledger actuals; campaign admission does not spend
or reserve money. Offers cover the campaign interval and validate their evidence.

Reachability #91 is not yet a substrate in this tree. CampaignRoute is an explicit
host assertion with a channel SpecificationPin, evidence, validity interval and
terminal revocation. The required CampaignAdmission callback evaluates the pinned
audience and channel policy at the notice instant. No selector execution is
inferred from a pin. Hosts must use `wave` before Notifications dispatch; this API
does not send external messages or promise a transaction with an external provider.
Preferences are the Notification's immutable snapshot. A later route end can make a
historical wave unreadable for dispatch; this does not erase its admission event.

`response` requires a published Collaboration Entry by the actual recipient after
the notice instant, and a pinned attribution definition. It proves the linked
interaction, not causal conversion; domain attribution remains an extension.
`performance` validates Measurement assessments against the campaign's subject and
period. Metric producers own response aggregation; no automatic conversion count
or hidden workflow runs. Raw candidates require these readers before consumption.

Marketing, public-health, recruiting and security-awareness consumers share the
same model. Memory, SQLite and PostgreSQL tests cover missing members, host denial,
admission, stale heads, pause/closure, recipient attribution, measured performance,
route revocation, and tenant isolation.
