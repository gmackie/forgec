# Inventory

StockItemSpecification pins item meaning and unit. StockItem identifies a fungible
lot or one serialized ResourceSubject, with IdentifierSet. Immutable positions bind
item, place, custodian, condition, Allocation pool and reorder threshold. Consumers
provide warehouse, manufacturing, clinical/lab and IT asset vocabulary.

`Inventory.move` appends receipt, issue, transfer, return, reservation, release or
count-reconciliation effects against an exact previous item-journal head. All
positions of an item share one bounded history (256 movements). Transfers move
quantity between positions atomically; changing place, custody or condition is
an explicit transfer, never an in-place edit. Serialized quantities are exactly
one and total stock across positions cannot exceed one. Stock cannot go negative.

`position` replays authorized history into on-hand, reserved, available and reorder
gap projections. Returned, damaged and quarantined positions have zero available
stock. Returns enter returned-condition positions and require an explicit transfer
into usable stock. Only usable stock can be issued or reserved. Destructive
movement cannot consume reserved quantity unless it explicitly names that claim.

Reservations bind existing Allocation candidates. Booking and inventory admission
commit together using Engine.atomic; a reserved issue releases the Allocation
claim and decrements stock in the same transaction. Concurrent issue/reservation
attempts against a stale stock head fail without leaking allocation authority.
Inventory reservations remain conservative physical claims until explicitly
released or issued: calendar passage or an outside Allocation release does not
silently put stock back on the shelf. Raw Allocation claims alone do not grant
stock ownership. The pool ceiling is an external planning limit, not on-hand truth.

Counts carry sealed evidence. Reconciliation requires a count no older than the
previous movement, an exact nonzero adjustment and sufficient stock for existing
reservations. Unchanged counts remain evidence without an adjustment movement.
Reorder links bind a compatible Demand and expose the current gap; they do not
automatically purchase, receive stock or duplicate demand.

InventoryVisibility records EPCIS-inspired object, aggregation, transformation,
transaction and association context around an admitted movement with evidence.
These are typed visibility links, not an EPCIS wire protocol or an automatic
manufacturing transformation engine. Multi-item transformation conservation and
commercial transaction semantics belong to their owning domain operation.

Consumers must read through Inventory: raw movement candidates do not prove a
valid history. Quantity arithmetic uses exact six-decimal bigint values. Local
memory/SQLite/PostgreSQL tests cover movements, holds, count correction, serialized
identity, competing last-stock claims, atomic rollback, visibility and isolation.
