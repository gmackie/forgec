import type { DatabaseSync } from "node:sqlite";
import { emptyState, stateText, type State, type StateStore } from "./model.js";
export class SqliteState implements StateStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS console_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, data TEXT NOT NULL)",
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS console_publications (key TEXT PRIMARY KEY, reserved_at TEXT NOT NULL)",
    );
    db.prepare("INSERT OR IGNORE INTO console_state VALUES (1, 0, ?)").run(
      JSON.stringify(emptyState()),
    );
  }
  async reservePublication(key: string): Promise<boolean> {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO console_publications VALUES (?, ?)")
        .run(key, new Date().toISOString()).changes === 1
    );
  }
  async read(): Promise<State> {
    return JSON.parse(
      (
        this.db.prepare("SELECT data FROM console_state WHERE id=1").get() as {
          data: string;
        }
      ).data,
    ) as State;
  }
  async save(expected: number, next: State): Promise<boolean> {
    return (
      this.db
        .prepare(
          "UPDATE console_state SET revision=?, data=? WHERE id=1 AND revision=?",
        )
        .run(next.revision, stateText(next), expected).changes === 1
    );
  }
}
