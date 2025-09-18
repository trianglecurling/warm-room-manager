import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export interface PresetRow {
  id: number;
  context_name: string;
  name: string;
  data_json: string;
  created_at: string;
  updated_at: string;
}

const DB_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DB_DIR, 'wrmm.sqlite3');

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new Database(DB_PATH);

// Ensure FKs are not enforced, as contexts are external
try { db.pragma('foreign_keys = OFF'); } catch {}

db.pragma('journal_mode = WAL');

// If an old schema with FK exists, migrate it away
try {
  const rows = db.prepare(`PRAGMA table_info(presets);`).all();
  const hasPresets = Array.isArray(rows) && rows.length > 0;
  if (hasPresets) {
    const fkList = db.prepare(`PRAGMA foreign_key_list(presets);`).all();
    if (Array.isArray(fkList) && fkList.length > 0) {
      db.exec(`
        BEGIN IMMEDIATE TRANSACTION;
        CREATE TABLE IF NOT EXISTS presets_mig (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          context_name TEXT NOT NULL,
          name TEXT NOT NULL,
          data_json TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(context_name, name)
        );
        INSERT INTO presets_mig (id, context_name, name, data_json, created_at, updated_at)
          SELECT id, context_name, name, data_json, created_at, updated_at FROM presets;
        DROP TABLE presets;
        ALTER TABLE presets_mig RENAME TO presets;
        COMMIT;
      `);
    }
  }
} catch {}

// Only presets table; do not store contexts locally
// Note: Existing DBs may already have a contexts table and FK; new setups will not create them.
db.exec(`
  CREATE TABLE IF NOT EXISTS presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    context_name TEXT NOT NULL,
    name TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(context_name, name)
  );
`);

const stmt = {
  listPresetsByContext: db.prepare(
    'SELECT id, context_name, name, data_json, created_at, updated_at FROM presets WHERE context_name = ? ORDER BY name ASC'
  ),
  getPreset: db.prepare(
    'SELECT id, context_name, name, data_json, created_at, updated_at FROM presets WHERE context_name = ? AND name = ?'
  ),
  insertPreset: db.prepare(
    `INSERT INTO presets (context_name, name, data_json) VALUES (@context_name, @name, @data_json)
     ON CONFLICT(context_name, name) DO UPDATE SET data_json = excluded.data_json, updated_at = datetime('now')
     RETURNING id, context_name, name, data_json, created_at, updated_at`
  ),
  deletePreset: db.prepare('DELETE FROM presets WHERE context_name = ? AND name = ?'),
};

export const dbQueries = {
  listPresetsByContext(contextName: string): PresetRow[] {
    return stmt.listPresetsByContext.all(contextName) as PresetRow[];
  },
  getPreset(contextName: string, name: string): PresetRow | undefined {
    return stmt.getPreset.get(contextName, name) as PresetRow | undefined;
  },
  insertOrUpdatePreset(input: { context_name: string; name: string; data_json: string }): PresetRow {
    return stmt.insertPreset.get(input) as PresetRow;
  },
  deletePreset(contextName: string, name: string): { changes: number } {
    return stmt.deletePreset.run(contextName, name) as unknown as { changes: number };
  },
}; 