-- Added in M8: producing operation's trace context on outbox rows (plan §20).
ALTER TABLE forge_outbox ADD COLUMN trace TEXT;
