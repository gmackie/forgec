CREATE TABLE IF NOT EXISTS console_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  data TEXT NOT NULL
);
INSERT OR IGNORE INTO console_state VALUES (1, 0, '{"revision":0,"apps":[],"audit":[]}');
