# Keyed actor preview

GameSession (PlayTrek), StreamSession (Stream Conductor), and ExperienceSession
(LatchFlow) demonstrate typed keyed state and commands.

```forge
actor GameSession keyed by session {
  state SessionState
  on Action -> ApplyAction
}
```

The referenced function supplies the message input shape and must return the
actor state shape. The preview rejects function `uses`/`sends`: register synchronous
pure reducers with `ActorHost`. Reducers may run again on CAS contention. Return
external effects as data; never perform effects inside the reducer. Function-body
invocation with actor-bound capability semantics is still outstanding.

State changes, dedup receipts, pending effects and alarms are one CAS commit.
`initialize` creates one logical instance per tenant/key. `takeover` increments
a generation; stale generations cannot commit. A message ID replays its receipt
or rejects different content. Alarm occurrences have stable IDs and fire once in
the state ledger. Effects need idempotent delivery and explicit acknowledgement;
external delivery remains at-least-once.

The profile has explicit limits: 128 retained message receipts, 128 pending
effects, 32 alarms, and 256 KiB total document size. It rejects overflow rather
than evicting dedup evidence silently. Lifecycle archival and long-lived unbounded
message history are not implemented. Package/actor definition changes fail closed
and require migration. Keys remain tenant-scoped.

`ActorHost` works with SQLite/D1Storage or memory and exposes `fireDue` for the
local timer loop. `DurableObjectActorStore` commits native alarms in the same
Durable Object storage transaction as state; `DurableActorSession` supplies
command/alarm entrypoint bodies for one DO identity. Host wiring must authenticate
and authorize commands, and bind one actor identity per DO. Realtime connection
ownership/hibernation and generated deployments remain outstanding.

Only the explicit `actor-preview` profile with `node-sqlite` or
`cloudflare-do-preview` targets is accepted. Production portable/AWS targets are
rejected pending certification. Tests run identical concurrency, recovery, dedup,
fencing and alarm scenarios against memory, SQLite and a DO transaction facade.
The facade is not a live Cloudflare certification result.
