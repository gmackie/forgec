-- Added in M5: per-subscription delivery progress and the consumer processed ledger.
-- (the `delivered` column added here in M5 is part of the 0001 baseline now; SQLite cannot guard ALTER TABLE)
CREATE TABLE IF NOT EXISTS forge_processed (
  "tenant" TEXT NOT NULL,
  "subscription" TEXT NOT NULL,
  "message_id" TEXT NOT NULL,
  "at" TEXT NOT NULL,
  PRIMARY KEY (tenant, subscription, message_id)
);
