import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { env } from "../config/env";
import { schemaStatements } from "./schema";

let database: Database.Database | null = null;

const ensureColumn = (db: Database.Database, table: string, column: string, definition: string): void => {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const exists = columns.some((entry) => entry.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
};

const runMigrations = (db: Database.Database): void => {
  ensureColumn(db, "original_tweets", "first_seen_at", "TEXT");
  ensureColumn(db, "original_tweets", "original_created_at", "TEXT");
  ensureColumn(db, "original_tweets", "is_too_old", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "original_tweets", "ignored_reason", "TEXT");
  ensureColumn(db, "original_tweets", "alert_sent_at", "TEXT");
  ensureColumn(db, "original_tweets", "last_signal_sent", "TEXT");
  ensureColumn(db, "original_tweets", "original_author_followers_count", "INTEGER");
  ensureColumn(db, "detected_quote_tweets", "quote_chain", "TEXT");

  db.exec(`
    UPDATE original_tweets
    SET first_seen_at = COALESCE(first_seen_at, first_detected_at),
        is_too_old = COALESCE(is_too_old, 0),
        ignored_reason = CASE
          WHEN ignored_reason IS NULL AND is_too_old = 1 THEN 'too_old'
          ELSE ignored_reason
        END
  `);
};

export const getDb = (): Database.Database => {
  if (database) {
    return database;
  }

  fs.mkdirSync(path.dirname(env.databasePath), { recursive: true });
  database = new Database(env.databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");

  for (const statement of schemaStatements) {
    database.exec(statement);
  }

  runMigrations(database);

  return database;
};
