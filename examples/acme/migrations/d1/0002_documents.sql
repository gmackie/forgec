-- Added in M3: opaque documents (changesets, jobs, import staging).
CREATE TABLE forge_document (
  "tenant" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "body" TEXT NOT NULL,
  PRIMARY KEY (tenant, kind, id)
);
