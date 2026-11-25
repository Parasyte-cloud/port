-- One row per outbound notification message (e-mail, SMS, webhook) and what the provider answered.
CREATE TABLE IF NOT EXISTS deliveries (
  msg_id       TEXT PRIMARY KEY,
  org_id       TEXT,
  channel      TEXT NOT NULL,
  to_addr      TEXT,
  subject      TEXT,
  status       TEXT NOT NULL,
  provider_ref TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS deliveries_org ON deliveries (org_id, created_at);
