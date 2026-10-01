-- Optional versioned-artifact publication journal; apply only for composed publishers.
-- Keys and terminal receipts must not expire while clients can replay them.
CREATE TABLE IF NOT EXISTS forge_artifact_publications (
  tenant TEXT NOT NULL,
  artifact TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  intent TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'accepted', 'rejected', 'observed')),
  PRIMARY KEY (tenant, artifact, operation_key)
);
