# The Forge language

`.forge` files describe business-owned data and capabilities. Business partners
should recognize every declaration; engineers supply behaviour that cannot be
derived (in `impl/`). The reference package `examples/acme` exercises everything
below; `specs/language/` is normative.

## Package

`forge.toml` names the package, its source root, path dependencies and the
compatibility profile; `[observability]` sets SLO targets. `forge.lock` pins
dependency contracts and the compiler version (`forgec lock`; `forgec check`
fails with `E-LOCK-001` when it is stale).

```toml
[package]
name = "@acme/commerce"
version = "0.1.0"

[dependencies]
payments = { path = "../payments" }

[compatibility]
profile = "portable-v1"
targets = ["cloudflare-d1", "aws-dynamodb"]

[observability]
window = "28d"
[observability.slo.crud-write]
availability = "99.9%"
latency = { good = "99%", within = "1s" }
```

Identity is package + module + symbol, never file location: moving a
declaration between files changes nothing on the wire or in the database.

## Types, enums, shapes

```forge
enum CustomerTier {
  Standard = "standard"
  Gold = "gold"
}
type CustomerCode = text length 2..8 uppercase trim
shape SubmitOrderInput {
  order : Order
  expectedVersion : integer >= 1
}
```

Scalars: `id`, `text`, `integer`, `decimal<scale>`, `money<CUR>`, `boolean`,
`date`, `datetime`, `localTime`, `duration`, `email`. Refinements (`length`,
ranges, normalizers) are enforced identically by the compiler and the runtime
(see `specs/codecs`). A resource name used as a type is a reference;
`Resource.Record` is the record shape.

## Resources

```forge
export resource Order
  @tenant @timestamps @softDelete @versioned @audited
  @crud("/v1/orders", actions: [approve, complete, cancel])
{
  id : id
  customer : Customer @immutable
  site : Site
  subtotal : money<USD> >= 0
  tax : money<USD> >= 0
  total : money<USD> = subtotal + tax
  requestedOn : date
  notes : text? length <= 2000

  lifecycle status {
    initial Draft
    terminal Completed
    terminal Cancelled

    submit: Draft -> Submitted
    approve: Submitted -> Approved
    complete: Approved -> Completed
    cancel: Draft | Submitted | Approved -> Cancelled
      input { reason : text length 1..200 }
  }

  rules {
    site.customer == customer
  }

  list by customer
    order by createdAt desc
}
```

- `@crud` publishes generated create/get/update/delete/restore/find/list
  operations and the named lifecycle actions under `{path}/{id}/actions/<action>`.
- Uniqueness (`@unique`, `unique a, b within c`) is enforced atomically on both
  stores (claim rows / claim items in the same transaction).
- `find by` / `list by` are the only queries; every list is bounded and indexed
  on both targets (a scan is a compile error).
- References are checked race-safely at commit; deleting a referenced record is
  refused (`HasDependents`).
- `@effectiveDated(uniqueBy: [site])` gives half-open, non-overlapping intervals
  and an `effective` query; `@hierarchical` gives `parent`, `move`, `children`,
  `ancestors` with cycle-safe moves.

## Functions, channels, subscriptions

```forge
export function SubmitOrder
  @http(POST, "/v1/orders/{order}/submit")
{
  input SubmitOrderInput
  output Order.Record
  uses { Order read  Order.status.submit  Site read  payments.AuthorizePayment }
  sends { OrderSubmitted to OrderEvents }
  errors { SiteDisabled  PaymentDeclined  PaymentUnavailable }
  slo { availability 99.9% over 28d  latency 99% <= 1s over 28d }
}

export channel OrderEvents
  @websocket("/v1/live/orders")
{
  distribution broadcast
  delivery at-least-once
  message OrderSubmitted { order : Order  customer : Customer  revision : integer >= 1 }
}

on OrderEvents.OrderSubmitted -> FulfillOrder
```

The body lives in `impl/` (`defineFunction`) and sees exactly the declared
capabilities. Writes and `send`s commit together at the end of the body. Each
subscription is one durable delivery (outbox → Cloudflare Queue / SQS);
consumers dedup by message id. `@websocket` makes the channel a realtime stream.

## Workflows

```forge
export workflow ProcessOrder
  @http(POST, "/v1/orders/{order}/process")
{
  input ProcessOrderInput
  output Order.Record
  version 1

  step submit = SubmitOrder(order: input.order, expectedVersion: input.expectedVersion)
    catch PaymentDeclined -> fail Declined

  step captured = wait PaymentEvents.PaymentCaptured
    where reference == input.order
    timeout 2d -> fail PaymentTimeout

  if captured.amount < submit.total {
    step short = Order.status.cancel(id: input.order, expectedVersion: submit.version, reason: "short payment")
    fail ShortPayment
  }

  step approve = Order.status.approve(id: input.order, expectedVersion: submit.version)

  parallel {
    step summary = RebuildOrderSummary()
    step settle = sleep 5s
  }

  return approve

  errors { Declined  PaymentTimeout  ShortPayment }
}
```

Step ids are the step names (stable identifiers). `version` pins in-flight
instances; changing the graph without bumping it is a compile-time
compatibility error (`forgec compat`). Cloudflare Workflows and Step Functions
drive the same portable executor.

## Views, projections, caches

```forge
export view PendingOrders {
  from Order
  by customer
  where status == Order.Status.Submitted
  order by createdAt desc, id desc
  fields id, site, total, requestedOn
}

export projection CustomerOrderSummary
  @crud("/v1/customer-order-summaries", operations: [get, list])
{
  from Order
  by customer
  where status != Order.Status.Cancelled
  count orders
  sum total as orderTotal
}

export cache CurrentSitePolicy {
  key site : Site
  loader SitePolicy.effective(site, now)
  freshUntil min(5m, nextEffectiveBoundary)
}
```

Views lower to a bounded list + filter (a missing partition key is a
validation error, never a scan). Projections are maintained from change events
with a contribution ledger (stale events never overwrite newer contributions)
and are rebuildable into a new generation. Caches are cache-aside with explicit
freshness; expired entries are rejected before any physical cleanup.

## Schedules

```forge
source NightlyReconciliation {
  cron "0 3 * * *"
  timezone "UTC"
  -> RebuildOrderSummary
}
```

Cron compiles to an explicit recurrence (0/7 = Sunday, day-of-month OR
day-of-week, IANA zone). Occurrence identity is schedule + intended instant;
missed runs catch up in order within a window; overlapping runs are skipped.

## Structural facets (edition 2027)

Declare reusable fields with `facet ContactDetails { email : email? }` and apply
with `resource Customer @facet(ContactDetails) { id : id }`.
`@facet(A, B)` and repeated `@facet(A) @facet(B)` are equivalent. Facets are
compile-time field composition: no subtyping, runtime type tests, or overrides.
Fields may have defaults, constraints, `@immutable`, `@label`, and `@data`.
Identity, derived fields, uniqueness, lifecycle, queries, capabilities, and
resource decorators cannot be supplied by a facet. All collisions fail compilation,
including synthesized fields such as `version` on a versioned resource.

Exported facets may be used through an imported dependency alias. Their field
types resolve in the defining package. Compatibility compares the effective
resource contracts and includes facet origins in affected-field explanations.
See `examples/facets` for game and business examples.
