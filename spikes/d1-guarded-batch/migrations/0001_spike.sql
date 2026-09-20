-- Spike schema: one resource table, the two "must not leak on failure" side
-- tables, and the per-command assertion table whose CHECK constraint is the
-- rollback trigger under test.
CREATE TABLE customer (
  tenant  TEXT    NOT NULL,
  id      TEXT    NOT NULL,
  version INTEGER NOT NULL,
  name    TEXT    NOT NULL,
  PRIMARY KEY (tenant, id)
);

CREATE TABLE audit (
  tenant      TEXT    NOT NULL,
  op_id       TEXT    NOT NULL,
  resource    TEXT    NOT NULL,
  record_id   TEXT    NOT NULL,
  new_version INTEGER NOT NULL,
  PRIMARY KEY (tenant, op_id)
);

CREATE TABLE outbox (
  tenant  TEXT    NOT NULL,
  op_id   TEXT    NOT NULL,
  ordinal INTEGER NOT NULL,
  payload TEXT    NOT NULL,
  PRIMARY KEY (tenant, op_id, ordinal)
);

CREATE TABLE _forge_assert (
  op_id     TEXT    PRIMARY KEY,
  satisfied INTEGER NOT NULL CHECK (satisfied = 1)
);
