import "dotenv/config";
import path from "path";
import fs from "fs";
import Database, { type Database as DatabaseType } from "better-sqlite3";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WikiEntry {
  id: number;
  topic: string;
  content: string;
}

// ---------------------------------------------------------------------------
// DB initialisation
// ---------------------------------------------------------------------------

const DB_PATH = process.env.DATABASE_PATH ?? "./data/pixels-assistant.db";

// Ensure the parent directory exists before opening the file
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db: DatabaseType = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS wiki_entries (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    topic   TEXT    NOT NULL UNIQUE,
    content TEXT    NOT NULL
  )
`);

// One row per land — upserted on every extension report.
// observed_at: epoch ms from the extension snapshot (when the player saw the state).
// updated_at:  epoch ms when the server received the report.
// permissions / industries: JSON-encoded blobs from the Colyseus room state.
db.exec(`
  CREATE TABLE IF NOT EXISTS land_reports (
    land_id     TEXT    PRIMARY KEY,
    observed_at INTEGER NOT NULL,
    permissions TEXT    NOT NULL DEFAULT '{}',
    industries  TEXT    NOT NULL DEFAULT '[]',
    updated_at  INTEGER NOT NULL
  )
`);

// ---------------------------------------------------------------------------
// Land report helpers
// ---------------------------------------------------------------------------

export interface LandReportRow {
  land_id:     string;
  observed_at: number;
  permissions: string; // JSON
  industries:  string; // JSON
  updated_at:  number;
}

const upsertLandReportStmt = db.prepare<
  [string, number, string, string, number]
>(`
  INSERT INTO land_reports (land_id, observed_at, permissions, industries, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(land_id) DO UPDATE SET
    observed_at = excluded.observed_at,
    permissions = excluded.permissions,
    industries  = excluded.industries,
    updated_at  = excluded.updated_at
`);

export function upsertLandReport(params: {
  landId:      string;
  observedAt:  number;
  permissions: unknown;
  industries:  unknown;
}): void {
  upsertLandReportStmt.run(
    params.landId,
    params.observedAt,
    JSON.stringify(params.permissions ?? {}),
    JSON.stringify(params.industries  ?? []),
    Date.now(),
  );
}

// ---------------------------------------------------------------------------
// land_placements — full-coverage map metadata from the background crawler.
//
// Two sources per land, fetched on each crawl cycle:
//   /v1/map/pixelsNFTFarm-{n}              → name, owner_address, land_type, tiers_available
//   /v1/infiniportal/farm_details/{n}      → entities, soil_count, tree_count,
//                                            permissions_use, owner_username
//
// Rows persist across container restarts via ON CONFLICT DO UPDATE.
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS land_placements (
    land_id         TEXT    PRIMARY KEY,
    name            TEXT,
    owner_address   TEXT,
    owner_username  TEXT,
    land_type       TEXT,
    tiers_available TEXT    NOT NULL DEFAULT '[]',
    entities        TEXT    NOT NULL DEFAULT '[]',
    soil_count      INTEGER,
    tree_count      INTEGER,
    permissions_use TEXT    NOT NULL DEFAULT '[]',
    last_crawled    INTEGER NOT NULL
  )
`);

// Migration: add columns introduced after initial schema deployment.
// ALTER TABLE ADD COLUMN fails if the column exists, so we catch and ignore.
for (const ddl of [
  "ALTER TABLE land_placements ADD COLUMN owner_username  TEXT",
  "ALTER TABLE land_placements ADD COLUMN entities        TEXT    NOT NULL DEFAULT '[]'",
  "ALTER TABLE land_placements ADD COLUMN soil_count      INTEGER",
  "ALTER TABLE land_placements ADD COLUMN tree_count      INTEGER",
  "ALTER TABLE land_placements ADD COLUMN permissions_use TEXT    NOT NULL DEFAULT '[]'",
]) {
  try { db.exec(ddl); } catch { /* column already exists */ }
}

const upsertLandPlacementStmt = db.prepare<
  [string, string | null, string | null, string | null, string | null, string,
   string, number | null, number | null, string, number]
>(`
  INSERT INTO land_placements
    (land_id, name, owner_address, owner_username, land_type, tiers_available,
     entities, soil_count, tree_count, permissions_use, last_crawled)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(land_id) DO UPDATE SET
    name            = excluded.name,
    owner_address   = excluded.owner_address,
    owner_username  = excluded.owner_username,
    land_type       = excluded.land_type,
    tiers_available = excluded.tiers_available,
    entities        = excluded.entities,
    soil_count      = excluded.soil_count,
    tree_count      = excluded.tree_count,
    permissions_use = excluded.permissions_use,
    last_crawled    = excluded.last_crawled
`);

export function upsertLandPlacement(params: {
  landId:         string;
  name:           string | null;
  ownerAddress:   string | null;
  ownerUsername:  string | null;
  landType:       string | null;
  tiersAvailable: string[];
  entities:       string[];
  soilCount:      number | null;
  treeCount:      number | null;
  permissionsUse: string[];
  lastCrawled:    number;
}): void {
  upsertLandPlacementStmt.run(
    params.landId,
    params.name,
    params.ownerAddress,
    params.ownerUsername,
    params.landType,
    JSON.stringify(params.tiersAvailable),
    JSON.stringify(params.entities),
    params.soilCount,
    params.treeCount,
    JSON.stringify(params.permissionsUse),
    params.lastCrawled,
  );
}

// ---------------------------------------------------------------------------
// game_locale — flat i18n key→text dictionary, refreshed every 24h from
// /v1/i18n/game/en.  first_seen / last_seen are epoch ms.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS game_locale (
    key        TEXT    PRIMARY KEY,
    text       TEXT    NOT NULL,
    first_seen INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL
  )
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_game_locale_first_seen ON game_locale (first_seen)`);

// Migration: the initial seed in 80ac914 incorrectly used first_seen = Date.now() instead of 0.
// Detect seed batches by finding first_seen values shared by 1000+ rows (only a bulk seed
// produces that many rows at the same timestamp), then reset them to 0.
// This runs on every startup but is a no-op once first_seen values are corrected.
try {
  const seedBatches = db.prepare<[]>(`
    SELECT first_seen FROM game_locale
    WHERE first_seen > 0
    GROUP BY first_seen HAVING COUNT(*) > 1000
  `).all() as Array<{ first_seen: number }>;
  for (const { first_seen } of seedBatches) {
    db.prepare<[number]>(`UPDATE game_locale SET first_seen = 0 WHERE first_seen = ?`).run(first_seen);
  }
  if (seedBatches.length > 0) {
    console.log(`[db] reset first_seen=0 for ${seedBatches.length} seed batch(es) in game_locale`);
  }
} catch { /* table may not exist yet on very first boot */ }

export interface GameLocaleRow {
  key:        string;
  text:       string;
  first_seen: number;
  last_seen:  number;
}

const countLocaleStmt = db.prepare<[]>(`SELECT COUNT(*) as count FROM game_locale`);

export function countLocaleKeys(): number {
  return (countLocaleStmt.get() as { count: number }).count;
}

const upsertLocaleKeyStmt = db.prepare<[string, string, number, number]>(`
  INSERT INTO game_locale (key, text, first_seen, last_seen)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET
    text      = excluded.text,
    last_seen = excluded.last_seen
`);

export function upsertLocaleKeys(
  entries: Array<{ key: string; text: string }>,
  now: number,
): { upserted: number; newKeys: string[] } {
  const existsStmt = db.prepare<[string]>(`SELECT key FROM game_locale WHERE key = ?`);
  const newKeys: string[] = [];
  const upsert = db.transaction(() => {
    for (const { key, text } of entries) {
      const exists = existsStmt.get(key);
      if (!exists) newKeys.push(key);
      upsertLocaleKeyStmt.run(key, text, now, now);
    }
  });
  upsert();
  return { upserted: entries.length, newKeys };
}

const getNewLocaleNameKeysStmt = db.prepare<[number]>(`
  SELECT key, text, first_seen FROM game_locale
  WHERE key LIKE '%_name' AND first_seen >= ?
  ORDER BY first_seen DESC
`);

export function getNewLocaleNameKeys(sinceMs: number): GameLocaleRow[] {
  return getNewLocaleNameKeysStmt.all(sinceMs) as GameLocaleRow[];
}

const getAllLocaleStmt = db.prepare<[]>(`SELECT key, text FROM game_locale`);

export function getAllLocaleRows(): Array<{ key: string; text: string }> {
  return getAllLocaleStmt.all() as Array<{ key: string; text: string }>;
}

// ---------------------------------------------------------------------------
// player_state — per-wallet onboarding preferences, persisted across boots.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS player_state (
    wallet_address    TEXT    PRIMARY KEY,
    goals             TEXT,
    time_available    TEXT,
    sociability_level INTEGER DEFAULT 3,
    timezone          TEXT,
    persona           TEXT    DEFAULT 'pixin',
    onboarded_at      INTEGER,
    updated_at        INTEGER
  )
`);

try { db.exec("ALTER TABLE player_state ADD COLUMN persona TEXT DEFAULT 'pixin'"); } catch { /* already exists */ }

export interface PlayerStateRow {
  wallet_address:    string;
  goals:             string | null;
  time_available:    string | null;
  sociability_level: number;
  timezone:          string | null;
  persona:           string;
  onboarded_at:      number | null;
  updated_at:        number | null;
}

// Partial upsert: absent fields (null) are preserved via COALESCE.
// onboarded_at is only set on first insert — never overwritten thereafter.
const upsertPlayerStateStmt = db.prepare<
  [string, string | null, string | null, number | null, string | null, string | null, number, number]
>(`
  INSERT INTO player_state
    (wallet_address, goals, time_available, sociability_level, timezone, persona, onboarded_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(wallet_address) DO UPDATE SET
    goals             = COALESCE(excluded.goals,             player_state.goals),
    time_available    = COALESCE(excluded.time_available,    player_state.time_available),
    sociability_level = COALESCE(excluded.sociability_level, player_state.sociability_level),
    timezone          = COALESCE(excluded.timezone,          player_state.timezone),
    persona           = COALESCE(excluded.persona,           player_state.persona),
    onboarded_at      = COALESCE(player_state.onboarded_at,  excluded.onboarded_at),
    updated_at        = excluded.updated_at
`);

export function upsertPlayerState(params: {
  walletAddress:     string;
  goals?:            string | null;
  timeAvailable?:    string | null;
  sociabilityLevel?: number | null;
  timezone?:         string | null;
  persona?:          string | null;
}): void {
  const now = Date.now();
  upsertPlayerStateStmt.run(
    params.walletAddress,
    params.goals            ?? null,
    params.timeAvailable    ?? null,
    params.sociabilityLevel ?? null,
    params.timezone         ?? null,
    params.persona          ?? null,
    now,  // onboarded_at — only lands on first insert
    now,  // updated_at   — always refreshed
  );
}

const getPlayerStateStmt = db.prepare<[string]>(
  `SELECT * FROM player_state WHERE wallet_address = ?`
);

export function getPlayerState(walletAddress: string): PlayerStateRow | undefined {
  return getPlayerStateStmt.get(walletAddress) as PlayerStateRow | undefined;
}

// ---------------------------------------------------------------------------
// player_goals — running list of player-defined goals, managed via the API.
// Separate from player_state.goals (the one-time onboarding capture).
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS player_goals (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT    NOT NULL,
    goal_text      TEXT    NOT NULL,
    status         TEXT    DEFAULT 'active',
    created_at     INTEGER,
    updated_at     INTEGER
  )
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_player_goals_wallet
    ON player_goals (wallet_address, status, created_at DESC)
`);

export interface PlayerGoalRow {
  id:             number;
  wallet_address: string;
  goal_text:      string;
  status:         string;
  created_at:     number;
  updated_at:     number;
}

const insertGoalStmt = db.prepare<[string, string, number, number]>(`
  INSERT INTO player_goals (wallet_address, goal_text, created_at, updated_at)
  VALUES (?, ?, ?, ?)
`);

export function insertGoal(walletAddress: string, goalText: string): PlayerGoalRow {
  const now = Date.now();
  const result = insertGoalStmt.run(walletAddress, goalText, now, now);
  return getGoalById(result.lastInsertRowid as number)!;
}

const getGoalByIdStmt = db.prepare<[number]>(
  `SELECT * FROM player_goals WHERE id = ?`
);

export function getGoalById(id: number): PlayerGoalRow | undefined {
  return getGoalByIdStmt.get(id) as PlayerGoalRow | undefined;
}

const listActiveGoalsStmt = db.prepare<[string]>(
  `SELECT * FROM player_goals WHERE wallet_address = ? AND status = 'active' ORDER BY created_at DESC`
);

export function listActiveGoals(walletAddress: string): PlayerGoalRow[] {
  return listActiveGoalsStmt.all(walletAddress) as PlayerGoalRow[];
}

const VALID_STATUSES = new Set(['active', 'done', 'dropped']);

const updateGoalStatusStmt = db.prepare<[string, number, number]>(
  `UPDATE player_goals SET status = ?, updated_at = ? WHERE id = ?`
);

export function updateGoalStatus(
  id: number,
  status: string,
): PlayerGoalRow | null {
  if (!VALID_STATUSES.has(status)) return null;
  updateGoalStatusStmt.run(status, Date.now(), id);
  return getGoalById(id) ?? null;
}

// ---------------------------------------------------------------------------
// skill_thresholds — manually-curated prep advice keyed by skill + level.
// item_id links to a live-library item (e.g. "itm_bronzemagnifyingglass").
// No seed data — entries will be supplied via the admin API.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS skill_thresholds (
    id          TEXT    PRIMARY KEY,
    skill       TEXT    NOT NULL,
    level       INTEGER NOT NULL,
    item_id     TEXT,
    prep_advice TEXT,
    updated_at  INTEGER NOT NULL
  )
`);

export interface SkillThresholdRow {
  id:          string;
  skill:       string;
  level:       number;
  item_id:     string | null;
  prep_advice: string | null;
  updated_at:  number;
}

const upsertSkillThresholdStmt = db.prepare<
  [string, string, number, string | null, string | null, number]
>(`
  INSERT INTO skill_thresholds (id, skill, level, item_id, prep_advice, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    skill       = excluded.skill,
    level       = excluded.level,
    item_id     = excluded.item_id,
    prep_advice = excluded.prep_advice,
    updated_at  = excluded.updated_at
`);

export function upsertSkillThreshold(
  row: Omit<SkillThresholdRow, 'updated_at'>,
): void {
  upsertSkillThresholdStmt.run(
    row.id,
    row.skill,
    row.level,
    row.item_id,
    row.prep_advice,
    Date.now(),
  );
}

const listSkillThresholdsStmt = db.prepare<[string]>(
  `SELECT * FROM skill_thresholds WHERE skill = ? ORDER BY level ASC`
);

export function listSkillThresholds(skill: string): SkillThresholdRow[] {
  return listSkillThresholdsStmt.all(skill) as SkillThresholdRow[];
}

const upcomingThresholdsStmt = db.prepare<[string, number, number]>(
  `SELECT * FROM skill_thresholds WHERE skill = ? AND level > ? AND level <= ? ORDER BY level ASC`
);

export function getUpcomingThresholds(
  skill: string,
  currentLevel: number,
  lookahead: number,
): SkillThresholdRow[] {
  return upcomingThresholdsStmt.all(skill, currentLevel, currentLevel + lookahead) as SkillThresholdRow[];
}

// ---------------------------------------------------------------------------
// notebook_goals — player-defined checklist items, keyed by player_id (UUID).
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS notebook_goals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id   TEXT    NOT NULL,
    text        TEXT    NOT NULL,
    completed   INTEGER NOT NULL DEFAULT 0,
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_nb_goals_player ON notebook_goals (player_id, created_at DESC)`);

export interface NotebookGoalRow {
  id: number;
  player_id: string;
  text: string;
  completed: number;
  position: number;
  created_at: number;
}

const insertNotebookGoalStmt = db.prepare<[string, string, string, number]>(`
  INSERT INTO notebook_goals (player_id, text, position, created_at)
  VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM notebook_goals WHERE player_id = ?), ?)
`);
const getNotebookGoalByIdStmt = db.prepare<[number]>(`SELECT * FROM notebook_goals WHERE id = ?`);
const listNotebookGoalsStmt   = db.prepare<[string]>(`SELECT * FROM notebook_goals WHERE player_id = ? ORDER BY position ASC, created_at ASC`);
const updateNotebookGoalStmt  = db.prepare<[string, number, number, number]>(`UPDATE notebook_goals SET text = ?, completed = ?, position = ? WHERE id = ?`);
const deleteNotebookGoalStmt  = db.prepare<[number, string]>(`DELETE FROM notebook_goals WHERE id = ? AND player_id = ?`);

export function insertNotebookGoal(playerId: string, text: string): NotebookGoalRow {
  const now = Date.now();
  const r = insertNotebookGoalStmt.run(playerId, text, playerId, now);
  return getNotebookGoalByIdStmt.get(r.lastInsertRowid as number) as NotebookGoalRow;
}

export function listNotebookGoals(playerId: string): NotebookGoalRow[] {
  return listNotebookGoalsStmt.all(playerId) as NotebookGoalRow[];
}

export function updateNotebookGoal(
  id: number,
  playerId: string,
  patch: { text?: string; completed?: boolean },
): NotebookGoalRow | null {
  const current = getNotebookGoalByIdStmt.get(id) as NotebookGoalRow | undefined;
  if (!current || current.player_id !== playerId) return null;
  const newText      = patch.text      ?? current.text;
  const newCompleted = patch.completed !== undefined ? (patch.completed ? 1 : 0) : current.completed;
  updateNotebookGoalStmt.run(newText, newCompleted, current.position, id);
  return getNotebookGoalByIdStmt.get(id) as NotebookGoalRow;
}

export function deleteNotebookGoal(id: number, playerId: string): void {
  deleteNotebookGoalStmt.run(id, playerId);
}

// ---------------------------------------------------------------------------
// shopping_list_items — player's per-item shopping list, keyed by player_id.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS shopping_list_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id   TEXT    NOT NULL,
    text        TEXT    NOT NULL,
    quantity    INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_shopping_player ON shopping_list_items (player_id, created_at ASC)`);

export interface ShoppingListItemRow {
  id: number;
  player_id: string;
  text: string;
  quantity: number;
  created_at: number;
}

const insertShoppingItemStmt = db.prepare<[string, string, number, number]>(`
  INSERT INTO shopping_list_items (player_id, text, quantity, created_at) VALUES (?, ?, ?, ?)
`);
const getShoppingItemByIdStmt  = db.prepare<[number]>(`SELECT * FROM shopping_list_items WHERE id = ?`);
const listShoppingItemsStmt    = db.prepare<[string]>(`SELECT * FROM shopping_list_items WHERE player_id = ? ORDER BY created_at ASC`);
const deleteShoppingItemStmt   = db.prepare<[number, string]>(`DELETE FROM shopping_list_items WHERE id = ? AND player_id = ?`);

export function insertShoppingItem(playerId: string, text: string, quantity: number): ShoppingListItemRow {
  const now = Date.now();
  const r = insertShoppingItemStmt.run(playerId, text, quantity, now);
  return getShoppingItemByIdStmt.get(r.lastInsertRowid as number) as ShoppingListItemRow;
}

export function listShoppingItems(playerId: string): ShoppingListItemRow[] {
  return listShoppingItemsStmt.all(playerId) as ShoppingListItemRow[];
}

export function deleteShoppingItem(id: number, playerId: string): void {
  deleteShoppingItemStmt.run(id, playerId);
}

// ---------------------------------------------------------------------------
// game_catalog — precomputed one-row-per-item fact table, rebuilt from the
// game library whenever the library version or content hash changes.
// catalog_meta — single-row metadata tracking when the catalog was last built.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS game_catalog (
    item_id           TEXT    PRIMARY KEY,
    display_name      TEXT    NOT NULL,
    category          TEXT,
    industry          TEXT,
    tier              INTEGER,
    skill             TEXT,
    level_required    INTEGER,
    tool_type         TEXT,
    tool_min_tier     INTEGER,
    seed_id           TEXT,
    seed_name         TEXT,
    grow_time_minutes REAL,
    plant_energy      INTEGER,
    harvest_energy    INTEGER,
    harvest_xp        INTEGER,
    recipe_station    TEXT,
    recipe_inputs     TEXT,
    recipe_output_qty INTEGER,
    craft_time_minutes REAL,
    craft_energy      INTEGER,
    craft_xp          INTEGER,
    is_event_recipe   INTEGER NOT NULL DEFAULT 0,
    all_recipes       TEXT,
    library_ver       TEXT,
    updated_at        INTEGER NOT NULL
  )
`);

// Migration: add all_recipes column if it doesn't exist yet.
try { db.exec("ALTER TABLE game_catalog ADD COLUMN all_recipes TEXT"); } catch { /* already exists */ }
// Migration: add land_type column if it doesn't exist yet.
try { db.exec("ALTER TABLE game_catalog ADD COLUMN land_type TEXT"); } catch { /* already exists */ }

db.exec(`CREATE INDEX IF NOT EXISTS idx_catalog_industry ON game_catalog (industry, tier)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_catalog_skill ON game_catalog (skill, level_required)`);

db.exec(`
  CREATE TABLE IF NOT EXISTS catalog_meta (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    library_ver   TEXT    NOT NULL,
    content_hash  TEXT    NOT NULL,
    item_count    INTEGER NOT NULL DEFAULT 0,
    built_at      INTEGER NOT NULL
  )
`);

export interface CatalogRow {
  item_id:            string;
  display_name:       string;
  category:           string | null;
  industry:           string | null;
  tier:               number | null;
  skill:              string | null;
  level_required:     number | null;
  tool_type:          string | null;
  tool_min_tier:      number | null;
  seed_id:            string | null;
  seed_name:          string | null;
  grow_time_minutes:  number | null;
  plant_energy:       number | null;
  harvest_energy:     number | null;
  harvest_xp:         number | null;
  recipe_station:     string | null;
  recipe_inputs:      string | null; // JSON: [{id, name, qty}] — primary recipe
  recipe_output_qty:  number | null;
  craft_time_minutes: number | null;
  craft_energy:       number | null;
  craft_xp:           number | null;
  is_event_recipe:    number;
  all_recipes:        string | null; // JSON array of all recipes when multiple exist
  land_type:          string | null; // e.g. "WATER", "GRASS", "SPACE" for land-restricted items
  library_ver:        string | null;
  updated_at:         number;
}

const upsertCatalogRowStmt = db.prepare<[
  string, string, string|null, string|null, number|null,
  string|null, number|null, string|null, number|null,
  string|null, string|null, number|null, number|null, number|null, number|null,
  string|null, string|null, number|null, number|null, number|null, number|null,
  number, string|null, string|null, string|null, number
]>(`
  INSERT INTO game_catalog (
    item_id, display_name, category, industry, tier,
    skill, level_required, tool_type, tool_min_tier,
    seed_id, seed_name, grow_time_minutes, plant_energy, harvest_energy, harvest_xp,
    recipe_station, recipe_inputs, recipe_output_qty, craft_time_minutes, craft_energy, craft_xp,
    is_event_recipe, all_recipes, land_type, library_ver, updated_at
  ) VALUES (
    ?, ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?
  )
  ON CONFLICT(item_id) DO UPDATE SET
    display_name      = excluded.display_name,
    category          = excluded.category,
    industry          = excluded.industry,
    tier              = excluded.tier,
    skill             = excluded.skill,
    level_required    = excluded.level_required,
    tool_type         = excluded.tool_type,
    tool_min_tier     = excluded.tool_min_tier,
    seed_id           = excluded.seed_id,
    seed_name         = excluded.seed_name,
    grow_time_minutes = excluded.grow_time_minutes,
    plant_energy      = excluded.plant_energy,
    harvest_energy    = excluded.harvest_energy,
    harvest_xp        = excluded.harvest_xp,
    recipe_station    = excluded.recipe_station,
    recipe_inputs     = excluded.recipe_inputs,
    recipe_output_qty = excluded.recipe_output_qty,
    craft_time_minutes = excluded.craft_time_minutes,
    craft_energy      = excluded.craft_energy,
    craft_xp          = excluded.craft_xp,
    is_event_recipe   = excluded.is_event_recipe,
    all_recipes       = excluded.all_recipes,
    land_type         = excluded.land_type,
    library_ver       = excluded.library_ver,
    updated_at        = excluded.updated_at
`);

export function upsertCatalogRow(row: Omit<CatalogRow, "updated_at">): void {
  upsertCatalogRowStmt.run(
    row.item_id, row.display_name, row.category, row.industry, row.tier,
    row.skill, row.level_required, row.tool_type, row.tool_min_tier,
    row.seed_id, row.seed_name, row.grow_time_minutes, row.plant_energy, row.harvest_energy, row.harvest_xp,
    row.recipe_station, row.recipe_inputs, row.recipe_output_qty, row.craft_time_minutes, row.craft_energy, row.craft_xp,
    row.is_event_recipe, row.all_recipes, row.land_type ?? null, row.library_ver, Date.now(),
  );
}

const getCatalogRowStmt = db.prepare<[string]>(`SELECT * FROM game_catalog WHERE item_id = ?`);
export function getCatalogRow(itemId: string): CatalogRow | undefined {
  return getCatalogRowStmt.get(itemId) as CatalogRow | undefined;
}

const listCatalogRowsStmt = db.prepare<[]>(`SELECT * FROM game_catalog ORDER BY display_name ASC`);
export function listCatalogRows(): CatalogRow[] {
  return listCatalogRowsStmt.all() as CatalogRow[];
}

const countCatalogRowsStmt = db.prepare<[]>(`SELECT COUNT(*) as count FROM game_catalog`);
export function countCatalogRows(): number {
  return (countCatalogRowsStmt.get() as { count: number }).count;
}

const clearCatalogStmt = db.prepare<[]>(`DELETE FROM game_catalog`);
export function clearCatalog(): void {
  clearCatalogStmt.run();
}

export interface CatalogMetaRow {
  library_ver:  string;
  content_hash: string;
  item_count:   number;
  built_at:     number;
}

const getCatalogMetaStmt = db.prepare<[]>(`SELECT * FROM catalog_meta WHERE id = 1`);
export function getCatalogMeta(): CatalogMetaRow | undefined {
  return getCatalogMetaStmt.get() as CatalogMetaRow | undefined;
}

const upsertCatalogMetaStmt = db.prepare<[string, string, number, number]>(`
  INSERT INTO catalog_meta (id, library_ver, content_hash, item_count, built_at)
  VALUES (1, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    library_ver  = excluded.library_ver,
    content_hash = excluded.content_hash,
    item_count   = excluded.item_count,
    built_at     = excluded.built_at
`);
export function upsertCatalogMeta(ver: string, hash: string, itemCount: number): void {
  upsertCatalogMetaStmt.run(ver, hash, itemCount, Date.now());
}

// ---------------------------------------------------------------------------
// timers — manual countdown timers, keyed by player_id.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS timers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id   TEXT    NOT NULL,
    label       TEXT    NOT NULL,
    fire_at     INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_timers_player ON timers (player_id, fire_at ASC)`);

export interface TimerRow {
  id: number;
  player_id: string;
  label: string;
  fire_at: number;
  created_at: number;
}

const insertTimerStmt   = db.prepare<[string, string, number, number]>(`INSERT INTO timers (player_id, label, fire_at, created_at) VALUES (?, ?, ?, ?)`);
const getTimerByIdStmt  = db.prepare<[number]>(`SELECT * FROM timers WHERE id = ?`);
const listTimersStmt    = db.prepare<[string]>(`SELECT * FROM timers WHERE player_id = ? ORDER BY fire_at ASC`);
const deleteTimerStmt   = db.prepare<[number, string]>(`DELETE FROM timers WHERE id = ? AND player_id = ?`);

export function insertTimer(playerId: string, label: string, fireAt: number): TimerRow {
  const now = Date.now();
  const r = insertTimerStmt.run(playerId, label, fireAt, now);
  return getTimerByIdStmt.get(r.lastInsertRowid as number) as TimerRow;
}

export function listTimers(playerId: string): TimerRow[] {
  return listTimersStmt.all(playerId) as TimerRow[];
}

export function deleteTimer(id: number, playerId: string): void {
  deleteTimerStmt.run(id, playerId);
}

// ---------------------------------------------------------------------------
// player_snapshots — daily skill/coin snapshots for diary diff.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS player_snapshots (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id     TEXT    NOT NULL,
    snapshot_date TEXT    NOT NULL,
    skills        TEXT    NOT NULL DEFAULT '{}',
    coins         TEXT    NOT NULL DEFAULT '{}',
    created_at    INTEGER NOT NULL,
    UNIQUE(player_id, snapshot_date)
  )
`);

export interface PlayerSnapshotRow {
  id: number;
  player_id: string;
  snapshot_date: string;
  skills: string;
  coins: string;
  created_at: number;
}

const upsertSnapshotStmt      = db.prepare<[string, string, string, string, number]>(`
  INSERT INTO player_snapshots (player_id, snapshot_date, skills, coins, created_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(player_id, snapshot_date) DO UPDATE SET
    skills     = excluded.skills,
    coins      = excluded.coins,
    created_at = excluded.created_at
`);
const getLatestSnapshotStmt   = db.prepare<[string]>(`SELECT * FROM player_snapshots WHERE player_id = ? ORDER BY snapshot_date DESC LIMIT 1`);

// ---------------------------------------------------------------------------
// diary_entries — auto-generated daily summaries, keyed by player_id.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS diary_entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id   TEXT    NOT NULL,
    entry_date  TEXT    NOT NULL,
    summary     TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    UNIQUE(player_id, entry_date)
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_diary_player ON diary_entries (player_id, entry_date DESC)`);

export interface DiaryEntryRow {
  id: number;
  player_id: string;
  entry_date: string;
  summary: string;
  created_at: number;
}

const getDiaryEntryStmt    = db.prepare<[string, string]>(`SELECT id FROM diary_entries WHERE player_id = ? AND entry_date = ?`);
const insertDiaryEntryStmt = db.prepare<[string, string, string, number]>(`
  INSERT OR IGNORE INTO diary_entries (player_id, entry_date, summary, created_at) VALUES (?, ?, ?, ?)
`);
const countDiaryEntriesStmt = db.prepare<[string]>(`SELECT COUNT(*) as count FROM diary_entries WHERE player_id = ?`);
const listDiaryEntriesStmt  = db.prepare<[string, number, number]>(`SELECT * FROM diary_entries WHERE player_id = ? ORDER BY entry_date DESC LIMIT ? OFFSET ?`);

export function listDiaryEntries(
  playerId: string,
  page: number,
  perPage: number,
): { entries: DiaryEntryRow[]; total: number } {
  const { count } = countDiaryEntriesStmt.get(playerId) as { count: number };
  const offset = (page - 1) * perPage;
  const entries = listDiaryEntriesStmt.all(playerId, perPage, offset) as DiaryEntryRow[];
  return { entries, total: count };
}

// ---------------------------------------------------------------------------
// runDailyDiary — called on first /ask of each UTC day for a playerId.
// Diffs current skills/coins against the most-recent snapshot and writes a
// plain-text summary to diary_entries.  Synchronous (better-sqlite3).
// ---------------------------------------------------------------------------

function normaliseSkills(raw: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'number') { out[k] = v; continue; }
    if (v && typeof v === 'object') {
      const lvl = (v as Record<string, unknown>).level ?? (v as Record<string, unknown>).current;
      if (typeof lvl === 'number') out[k] = lvl;
    }
  }
  return out;
}

function normaliseCoins(raw: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'number') { out[k] = v; continue; }
    if (v && typeof v === 'object') {
      const bal = (v as Record<string, unknown>).balance;
      if (typeof bal === 'number') out[k] = bal;
    }
  }
  return out;
}

export function runDailyDiary(
  playerId: string,
  rawSkills: Record<string, unknown>,
  rawCoins: Record<string, unknown>,
): void {
  const today = new Date().toISOString().slice(0, 10);

  // Already ran today — skip.
  if (getDiaryEntryStmt.get(playerId, today)) return;

  const skills = normaliseSkills(rawSkills);
  const coins  = normaliseCoins(rawCoins);

  const prevSnapshot = getLatestSnapshotStmt.get(playerId) as PlayerSnapshotRow | undefined;

  // Save today's snapshot (upsert so a second call today stays idempotent).
  upsertSnapshotStmt.run(playerId, today, JSON.stringify(skills), JSON.stringify(coins), Date.now());

  // No prior snapshot to diff against — silent save.
  if (!prevSnapshot) return;

  const prevSkills: Record<string, number> = JSON.parse(prevSnapshot.skills);
  const prevCoins:  Record<string, number> = JSON.parse(prevSnapshot.coins);

  const changes: string[] = [];

  // Skill level-ups
  for (const [skill, level] of Object.entries(skills)) {
    const prev = prevSkills[skill];
    if (prev !== undefined && level > prev) {
      const label = skill.replace(/([A-Z])/g, ' $1').replace(/\b\w/g, c => c.toUpperCase()).trim();
      changes.push(`${label} ${prev}→${level}`);
    }
  }

  // Coin net changes (only show if |delta| >= 1)
  for (const [currencyId, balance] of Object.entries(coins)) {
    const prev = prevCoins[currencyId] ?? 0;
    const delta = balance - prev;
    if (Math.abs(delta) < 1) continue;
    const label = currencyId
      .replace(/([A-Z])/g, ' $1')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase())
      .trim();
    const sign = delta >= 0 ? '+' : '';
    changes.push(`${sign}${Math.round(delta).toLocaleString('en-US')} ${label}`);
  }

  if (changes.length === 0) return;

  insertDiaryEntryStmt.run(playerId, today, changes.join('\n'), Date.now());
}

// ---------------------------------------------------------------------------
// market_prices — per-item price stats; upserted by the extension.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS market_prices (
    item_id         TEXT    PRIMARY KEY,
    min_price       REAL    NOT NULL,
    avg_price       REAL    NOT NULL,
    volume          INTEGER NOT NULL DEFAULT 0,
    sold_24h_est    REAL    NOT NULL DEFAULT 0,
    sold_7d_est     REAL    NOT NULL DEFAULT 0,
    avg_sale_price  REAL    NOT NULL DEFAULT 0,
    updated_at      INTEGER NOT NULL
  )
`);
// Migrate existing tables that lack the new columns.
for (const col of [
  "sold_24h_est REAL NOT NULL DEFAULT 0",
  "sold_7d_est REAL NOT NULL DEFAULT 0",
  "avg_sale_price REAL NOT NULL DEFAULT 0",
]) {
  try { db.exec(`ALTER TABLE market_prices ADD COLUMN ${col}`); } catch { /* already exists */ }
}

export interface MarketPriceRow {
  item_id:        string;
  min_price:      number;
  avg_price:      number;
  volume:         number;
  sold_24h_est:   number;
  sold_7d_est:    number;
  avg_sale_price: number;
  updated_at:     number;
}

const upsertMarketPriceStmt = db.prepare<[string, number, number, number, number, number, number, number]>(`
  INSERT INTO market_prices (item_id, min_price, avg_price, volume, sold_24h_est, sold_7d_est, avg_sale_price, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(item_id) DO UPDATE SET
    min_price       = excluded.min_price,
    avg_price       = excluded.avg_price,
    volume          = excluded.volume,
    sold_24h_est    = excluded.sold_24h_est,
    sold_7d_est     = excluded.sold_7d_est,
    avg_sale_price  = excluded.avg_sale_price,
    updated_at      = excluded.updated_at
`);
const getMarketPriceStmt = db.prepare<[string]>(`SELECT * FROM market_prices WHERE item_id = ?`);
const getMarketPricesStaleStmt = db.prepare<[number]>(
  `SELECT item_id FROM market_prices WHERE updated_at < ?`
);
const getAllMarketPricesStmt = db.prepare(`SELECT * FROM market_prices`);

export function upsertMarketPrice(
  itemId: string,
  minPrice: number,
  avgPrice: number,
  volume: number,
  sold24hEst = 0,
  sold7dEst = 0,
  avgSalePrice = 0,
): void {
  upsertMarketPriceStmt.run(itemId, minPrice, avgPrice, volume, sold24hEst, sold7dEst, avgSalePrice, Date.now());
}

export function getMarketPrice(itemId: string): MarketPriceRow | undefined {
  return getMarketPriceStmt.get(itemId) as MarketPriceRow | undefined;
}

export function getAllMarketPrices(): Map<string, MarketPriceRow> {
  const rows = getAllMarketPricesStmt.all() as MarketPriceRow[];
  return new Map(rows.map(r => [r.item_id, r]));
}

export function getStaleMarketItems(olderThanMs: number): string[] {
  const cutoff = Date.now() - olderThanMs;
  return (getMarketPricesStaleStmt.all(cutoff) as { item_id: string }[]).map(r => r.item_id);
}

// ---------------------------------------------------------------------------
// listing_purchases — tracks per-listing purchasedQuantity across fetches.
// Used for delta-based exact sales: an increase in purchasedQty = a real sale.
// Only listing_id + price are stored — no ownerId / ownerUsername.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS listing_purchases (
    listing_id  TEXT    PRIMARY KEY,
    item_id     TEXT    NOT NULL,
    last_pq     INTEGER NOT NULL DEFAULT 0,
    price       REAL    NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_listing_purch_item ON listing_purchases (item_id)`);

const getLpStmt  = db.prepare<[string]>(`SELECT last_pq FROM listing_purchases WHERE listing_id = ?`);
const upsertLpStmt = db.prepare<[string, string, number, number, number]>(`
  INSERT INTO listing_purchases (listing_id, item_id, last_pq, price, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(listing_id) DO UPDATE SET
    last_pq    = excluded.last_pq,
    price      = excluded.price,
    updated_at = excluded.updated_at
`);

export function getListingLastPq(listingId: string): number {
  const row = getLpStmt.get(listingId) as { last_pq: number } | undefined;
  return row !== undefined ? row.last_pq : -1; // -1 = never seen
}

export function upsertListingPurchase(listingId: string, itemId: string, pq: number, price: number): void {
  upsertLpStmt.run(listingId, itemId, pq, price, Date.now());
}

// ---------------------------------------------------------------------------
// market_sales — individual sale events; populated from recentSales field.
// recentSales shape from API: [{price: number, quantity: number, soldAt: number (unix ms)}]
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS market_sales (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id  TEXT    NOT NULL,
    sold_at  INTEGER NOT NULL,
    price    REAL    NOT NULL,
    quantity INTEGER NOT NULL
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_mkt_sales_item_sold ON market_sales (item_id, sold_at DESC)`);

export interface MarketSaleRow {
  id:       number;
  item_id:  string;
  sold_at:  number;
  price:    number;
  quantity: number;
}

const insertMarketSaleStmt = db.prepare<[string, number, number, number]>(`
  INSERT INTO market_sales (item_id, sold_at, price, quantity) VALUES (?, ?, ?, ?)
`);
const getSalesInWindowStmt = db.prepare<[string, number]>(`
  SELECT * FROM market_sales WHERE item_id = ? AND sold_at >= ? ORDER BY sold_at ASC
`);

export function insertMarketSale(itemId: string, soldAt: number, price: number, quantity: number): void {
  insertMarketSaleStmt.run(itemId, soldAt, price, quantity);
}

export function getSalesInWindow(itemId: string, sinceMs: number): MarketSaleRow[] {
  return getSalesInWindowStmt.all(itemId, sinceMs) as MarketSaleRow[];
}

export interface SalesRateResult {
  perDay:     number;
  trend:      "rising" | "steady" | "falling";
  sampleDays: number;
}

export function getSalesRate(itemId: string, days = 7): SalesRateResult {
  const windowMs = days * 86_400_000;
  const sales = getSalesInWindow(itemId, Date.now() - windowMs);
  if (sales.length === 0) return { perDay: 0, trend: "steady", sampleDays: days };

  const totalQty = sales.reduce((s, r) => s + r.quantity, 0);
  const perDay = totalQty / days;

  // Trend: compare first half vs second half of the window
  const midMs = Date.now() - windowMs / 2;
  const firstHalf = sales.filter(r => r.sold_at < midMs).reduce((s, r) => s + r.quantity, 0);
  const secondHalf = sales.filter(r => r.sold_at >= midMs).reduce((s, r) => s + r.quantity, 0);

  let trend: "rising" | "steady" | "falling" = "steady";
  if (firstHalf > 0 && secondHalf > firstHalf * 1.3) trend = "rising";
  else if (secondHalf < firstHalf * 0.7) trend = "falling";

  return { perDay, trend, sampleDays: days };
}

// ---------------------------------------------------------------------------
// taskboard_events — item_ids seen on taskboard snapshots; no player data.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS taskboard_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id    TEXT    NOT NULL,
    event_date TEXT    NOT NULL
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_tb_events_item_date ON taskboard_events (item_id, event_date DESC)`);

const insertTaskboardEventStmt = db.prepare<[string, string]>(`
  INSERT INTO taskboard_events (item_id, event_date) VALUES (?, ?)
`);
const getTaskboardFreqStmt = db.prepare<[string, string]>(`
  SELECT COUNT(DISTINCT event_date) as freq FROM taskboard_events
  WHERE item_id = ? AND event_date >= ?
`);

export function recordTaskboardEvent(itemId: string): void {
  const today = new Date().toISOString().slice(0, 10);
  insertTaskboardEventStmt.run(itemId, today);
}

export function getTaskboardFrequency(itemId: string, days = 7): number {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const row = getTaskboardFreqStmt.get(itemId, cutoff) as { freq: number };
  return row.freq;
}

// ---------------------------------------------------------------------------
// listing_snapshots — raw listing data per item per fetch.
// Consecutive snapshots are diffed to estimate sales (disappeared = probable sale).
// Keeps last 5 snapshots per item.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS listing_snapshots (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id    TEXT    NOT NULL,
    fetched_at INTEGER NOT NULL,
    listings   TEXT    NOT NULL
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_listing_snaps_item ON listing_snapshots (item_id, fetched_at DESC)`);

// ---------------------------------------------------------------------------
// market_estimated_demand — per-item demand derived from snapshot diffs.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS market_estimated_demand (
    item_id       TEXT    PRIMARY KEY,
    sales_per_day REAL    NOT NULL DEFAULT 0,
    trend         TEXT    NOT NULL DEFAULT 'steady',
    snap_count    INTEGER NOT NULL DEFAULT 0,
    updated_at    INTEGER NOT NULL
  )
`);

export interface ListingEntry {
  id:      string;
  ownerId: string | null;
  price:   number;
  qty:     number;
}

export interface EstimatedDemandRow {
  item_id:       string;
  sales_per_day: number;
  trend:         "rising" | "steady" | "falling";
  snap_count:    number;
  updated_at:    number;
}

const insertListingSnapStmt = db.prepare<[string, number, string]>(`
  INSERT INTO listing_snapshots (item_id, fetched_at, listings) VALUES (?, ?, ?)
`);
const getRecentSnapsStmt = db.prepare<[string]>(`
  SELECT id, fetched_at, listings FROM listing_snapshots
  WHERE item_id = ? ORDER BY fetched_at DESC LIMIT 5
`);
const pruneSnapsStmt = db.prepare<[string, string]>(`
  DELETE FROM listing_snapshots
  WHERE item_id = ? AND id NOT IN (
    SELECT id FROM listing_snapshots WHERE item_id = ? ORDER BY fetched_at DESC LIMIT 5
  )
`);
const upsertEstDemandStmt = db.prepare<[string, number, string, number, number]>(`
  INSERT INTO market_estimated_demand (item_id, sales_per_day, trend, snap_count, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(item_id) DO UPDATE SET
    sales_per_day = excluded.sales_per_day,
    trend         = excluded.trend,
    snap_count    = excluded.snap_count,
    updated_at    = excluded.updated_at
`);
const getEstDemandStmt = db.prepare<[string]>(`SELECT * FROM market_estimated_demand WHERE item_id = ?`);

export function upsertListingSnapshot(itemId: string, listings: ListingEntry[], fetchedAt: number): void {
  insertListingSnapStmt.run(itemId, fetchedAt, JSON.stringify(listings));
  pruneSnapsStmt.run(itemId, itemId);
}

export function computeAndStoreEstimatedDemand(itemId: string): void {
  const rows = getRecentSnapsStmt.all(itemId) as Array<{ id: number; fetched_at: number; listings: string }>;
  if (rows.length < 2) return;

  const newest = rows[0];
  const oldest = rows[rows.length - 1];
  const timeDeltaDays = (newest.fetched_at - oldest.fetched_at) / 86_400_000;
  if (timeDeltaDays <= 0) return;

  const oldListings: ListingEntry[] = JSON.parse(oldest.listings);
  const newListings: ListingEntry[] = JSON.parse(newest.listings);

  const oldMap = new Map<string, { qty: number }>();
  for (const l of oldListings) oldMap.set(l.id, { qty: l.qty });

  const newMap = new Map<string, { qty: number }>();
  for (const l of newListings) newMap.set(l.id, { qty: l.qty });

  let qtySold = 0;
  for (const [lid, old] of oldMap) {
    if (!newMap.has(lid)) {
      qtySold += old.qty;
    } else {
      const delta = old.qty - newMap.get(lid)!.qty;
      if (delta > 0) qtySold += delta;
    }
  }
  const salesPerDay = qtySold / timeDeltaDays;

  let trend: "rising" | "steady" | "falling" = "steady";
  if (rows.length >= 3) {
    const mid = rows[Math.floor(rows.length / 2)];
    const midListings: ListingEntry[] = JSON.parse(mid.listings);
    const midMap = new Map<string, number>();
    for (const l of midListings) midMap.set(l.id, l.qty);

    const firstHalfDays  = (mid.fetched_at - oldest.fetched_at) / 86_400_000;
    const secondHalfDays = (newest.fetched_at - mid.fetched_at) / 86_400_000;

    if (firstHalfDays > 0 && secondHalfDays > 0) {
      let sold1 = 0;
      for (const [lid, old] of oldMap) {
        if (!midMap.has(lid)) sold1 += old.qty;
        else { const d = old.qty - midMap.get(lid)!; if (d > 0) sold1 += d; }
      }

      const midMapFull = new Map<string, number>();
      for (const l of midListings) midMapFull.set(l.id, l.qty);
      let sold2 = 0;
      for (const [lid, mq] of midMapFull) {
        if (!newMap.has(lid)) sold2 += mq;
        else { const d = mq - newMap.get(lid)!.qty; if (d > 0) sold2 += d; }
      }

      const rate1 = sold1 / firstHalfDays;
      const rate2 = sold2 / secondHalfDays;
      if (rate2 > rate1 * 1.3) trend = "rising";
      else if (rate2 < rate1 * 0.7) trend = "falling";
    }
  }

  upsertEstDemandStmt.run(itemId, salesPerDay, trend, rows.length, Date.now());
}

export function getEstimatedDemand(itemId: string): EstimatedDemandRow | undefined {
  return getEstDemandStmt.get(itemId) as EstimatedDemandRow | undefined;
}

// ---------------------------------------------------------------------------
// tips — static tips loaded from data/tips.json on startup via loadStaticData.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS tips (
    id    TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    text  TEXT NOT NULL
  )
`);

export interface TipRow {
  id:    string;
  topic: string;
  text:  string;
}

const upsertTipStmt   = db.prepare<[string, string, string]>(`
  INSERT INTO tips (id, topic, text) VALUES (?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET topic = excluded.topic, text = excluded.text
`);
const listAllTipsStmt  = db.prepare<[]>(`SELECT * FROM tips ORDER BY topic, id`);
const listTipsByTopicStmt = db.prepare<[string]>(`SELECT * FROM tips WHERE topic = ? ORDER BY id`);

export function upsertTip(id: string, topic: string, text: string): void {
  upsertTipStmt.run(id, topic, text);
}

export function listAllTips(): TipRow[] {
  return listAllTipsStmt.all() as TipRow[];
}

export function listTipsByTopic(topic: string): TipRow[] {
  return listTipsByTopicStmt.all(topic) as TipRow[];
}

// ---------------------------------------------------------------------------
// guide_entries — static guides loaded from data/guides.json on startup.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS guide_entries (
    id       TEXT PRIMARY KEY,
    title    TEXT NOT NULL,
    keywords TEXT NOT NULL,
    content  TEXT NOT NULL
  )
`);

export interface GuideRow {
  id:       string;
  title:    string;
  keywords: string; // JSON array of strings
  content:  string;
}

const upsertGuideStmt = db.prepare<[string, string, string, string]>(`
  INSERT INTO guide_entries (id, title, keywords, content) VALUES (?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    title    = excluded.title,
    keywords = excluded.keywords,
    content  = excluded.content
`);
const listGuidesStmt = db.prepare<[]>(`SELECT * FROM guide_entries ORDER BY id`);

export function upsertGuide(id: string, title: string, keywords: string[], content: string): void {
  upsertGuideStmt.run(id, title, JSON.stringify(keywords), content);
}

export function listGuides(): GuideRow[] {
  return listGuidesStmt.all() as GuideRow[];
}

// ---------------------------------------------------------------------------
// loadStaticData — call on server startup to sync tips + guides from JSON files.
// ---------------------------------------------------------------------------

// static/ is the repo-shipped asset directory — separate from /app/data which
// Railway mounts as a persistent volume (hiding any image-baked files there).
export const STATIC_DIR = path.resolve(process.cwd(), "static");

export function loadStaticData(): void {
  console.log(`[static] loadStaticData called, staticDir=${STATIC_DIR}`);

  let tipsLoaded = 0;
  const tipsPath = path.join(STATIC_DIR, "tips.json");
  if (fs.existsSync(tipsPath)) {
    try {
      const tips = JSON.parse(fs.readFileSync(tipsPath, "utf-8")) as Array<{ id: string; topic: string; text: string }>;
      for (const t of tips) upsertTip(t.id, t.topic, t.text);
      tipsLoaded = tips.length;
    } catch (err) {
      console.error("[static] FAILED to load tips.json:", err);
    }
  } else {
    console.error(`[static] MISSING tips.json at ${tipsPath}`);
  }

  let guidesLoaded = 0;
  const guidesPath = path.join(STATIC_DIR, "guides.json");
  if (fs.existsSync(guidesPath)) {
    try {
      const guides = JSON.parse(fs.readFileSync(guidesPath, "utf-8")) as Array<{ id: string; title: string; keywords: string[]; content: string }>;
      for (const g of guides) upsertGuide(g.id, g.title, g.keywords, g.content);
      guidesLoaded = guides.length;
    } catch (err) {
      console.error("[static] FAILED to load guides.json:", err);
    }
  } else {
    console.error(`[static] MISSING guides.json at ${guidesPath}`);
  }

  console.log(`[static] loaded ${tipsLoaded} tips, ${guidesLoaded} guides`);
  if (tipsLoaded === 0) console.error("[static] ERROR: 0 tips loaded — tips fast path will be empty");
  if (guidesLoaded === 0) console.error("[static] ERROR: 0 guides loaded — guide fast path will fail");
}

// ---------------------------------------------------------------------------
// market_price_history — daily price snapshots for trend detection.
// One row per (item_id, snapshot_date); upserted each time a market price
// is updated so we can compare today vs 7 days ago.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS market_price_history (
    item_id        TEXT NOT NULL,
    snapshot_date  TEXT NOT NULL,
    avg_sale_price REAL NOT NULL DEFAULT 0,
    min_price      REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (item_id, snapshot_date)
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_mph_item ON market_price_history (item_id, snapshot_date DESC)`);

const upsertPriceHistoryStmt = db.prepare<[string, string, number, number]>(`
  INSERT INTO market_price_history (item_id, snapshot_date, avg_sale_price, min_price)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(item_id, snapshot_date) DO UPDATE SET
    avg_sale_price = excluded.avg_sale_price,
    min_price      = excluded.min_price
`);

export function upsertPriceHistory(itemId: string, avgSalePrice: number, minPrice: number): void {
  const today = new Date().toISOString().slice(0, 10);
  upsertPriceHistoryStmt.run(itemId, today, avgSalePrice, minPrice);
}

const getPriceHistoryRangeStmt = db.prepare<[string, string]>(`
  SELECT snapshot_date, avg_sale_price, min_price
  FROM market_price_history
  WHERE item_id = ? AND snapshot_date >= ?
  ORDER BY snapshot_date ASC
`);

export interface PriceHistoryPoint {
  snapshot_date:  string;
  avg_sale_price: number;
  min_price:      number;
}

export function getPriceHistory7d(itemId: string): PriceHistoryPoint[] {
  const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  return getPriceHistoryRangeStmt.all(itemId, cutoff) as PriceHistoryPoint[];
}

// Returns the % change between oldest and newest snapshot in the 7d window.
// Positive = rising, negative = falling. null = insufficient data (<2 points).
export function getPriceTrend7d(itemId: string): number | null {
  const rows = getPriceHistory7d(itemId);
  if (rows.length < 2) return null;
  const oldest = rows[0].avg_sale_price > 0 ? rows[0].avg_sale_price : rows[0].min_price;
  const newest = rows[rows.length - 1].avg_sale_price > 0
    ? rows[rows.length - 1].avg_sale_price
    : rows[rows.length - 1].min_price;
  if (oldest <= 0) return null;
  return (newest - oldest) / oldest;
}
