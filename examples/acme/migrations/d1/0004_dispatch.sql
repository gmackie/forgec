-- Added in M5: per-subscription delivery progress and the consumer processed ledger.
ALTER TABLE forge_outbox ADD COLUMN delivered TEXT;
CREATE TABLE forge_processed (
  "tenant" TEXT NOT NULL,
  "subscription" TEXT NOT NULL,
  "message_id" TEXT NOT NULL,
  "at" TEXT NOT NULL,
  PRIMARY KEY (tenant, subscription, message_id)
);
