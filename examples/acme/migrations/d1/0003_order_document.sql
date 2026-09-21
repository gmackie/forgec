-- Added in M4: OrderDocument blob metadata.
CREATE TABLE order_document (
  "tenant" TEXT NOT NULL,
  "id" TEXT NOT NULL,
  "order_" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  "upload_state" TEXT NOT NULL,
  "media_type" TEXT,
  "byte_count" INTEGER,
  "digest" TEXT,
  "upload_attempt" INTEGER,
  "staged_media_type" TEXT,
  "staged_byte_count" INTEGER,
  "content_generation" INTEGER,
  "sealed_generation" TEXT,
  PRIMARY KEY (tenant, id),
  FOREIGN KEY (tenant, order_) REFERENCES order_ (tenant, id)
);
CREATE INDEX order_document_ix_by_order ON order_document (tenant, order_, created_at, id);
