-- Delivery state for the outbox dispatcher: status, lease (owner + expiry), attempts.
ALTER TABLE outbox ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE outbox ADD COLUMN lease_owner TEXT;
ALTER TABLE outbox ADD COLUMN lease_until INTEGER;
ALTER TABLE outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX outbox_pending ON outbox (status, lease_until);
