-- Added in M6: effective-dated SitePolicy and hierarchical Department.
CREATE TABLE IF NOT EXISTS site_policy (
  "tenant" TEXT NOT NULL,
  "id" TEXT NOT NULL,
  "site" TEXT NOT NULL,
  "max_order_total" INTEGER NOT NULL,
  "requires_approval" INTEGER NOT NULL,
  "version" INTEGER NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  "effective_from" TEXT NOT NULL,
  "effective_until" TEXT,
  PRIMARY KEY (tenant, id),
  FOREIGN KEY (tenant, site) REFERENCES site (tenant, id)
);
CREATE INDEX IF NOT EXISTS site_policy_ix_by_site ON site_policy (tenant, site, effective_from, id);
CREATE TABLE IF NOT EXISTS department (
  "tenant" TEXT NOT NULL,
  "id" TEXT NOT NULL,
  "customer" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  "parent" TEXT,
  PRIMARY KEY (tenant, id),
  FOREIGN KEY (tenant, customer) REFERENCES customer (tenant, id),
  FOREIGN KEY (tenant, parent) REFERENCES department (tenant, id)
);
CREATE INDEX IF NOT EXISTS department_ix_by_customer ON department (tenant, customer, name, id);
