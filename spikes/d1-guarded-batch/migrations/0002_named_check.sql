-- Name the CHECK so the provider error carries a Forge-owned token
-- ("CHECK constraint failed: forge_precondition") instead of an SQL expression.
DROP TABLE _forge_assert;
CREATE TABLE _forge_assert (
  op_id     TEXT    PRIMARY KEY,
  satisfied INTEGER NOT NULL,
  CONSTRAINT forge_precondition CHECK (satisfied = 1)
);
