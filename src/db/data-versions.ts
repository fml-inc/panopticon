import type { Database } from "./driver.js";

export const RAW_SCANNER_COMPONENT = "scanner.raw";
export const INTENT_FROM_SCANNER_COMPONENT = "intent.from_scanner";
export const INTENT_FROM_HOOKS_COMPONENT = "intent.from_hooks";
export const LANDED_FROM_DISK_COMPONENT = "intent.landed_from_disk";
export const CLAIMS_ACTIVE_COMPONENT = "claims.active";
export const CLAIMS_PROJECTION_COMPONENT = "claims.projection";

export const DATA_COMPONENT_VERSIONS = {
  [RAW_SCANNER_COMPONENT]: 3,
  [INTENT_FROM_SCANNER_COMPONENT]: 2,
  [INTENT_FROM_HOOKS_COMPONENT]: 2,
  [LANDED_FROM_DISK_COMPONENT]: 3,
  [CLAIMS_ACTIVE_COMPONENT]: 1,
  [CLAIMS_PROJECTION_COMPONENT]: 1,
} as const;

export type DataComponent = keyof typeof DATA_COMPONENT_VERSIONS;

export const CLAIM_DATA_COMPONENTS = [
  INTENT_FROM_SCANNER_COMPONENT,
  INTENT_FROM_HOOKS_COMPONENT,
  LANDED_FROM_DISK_COMPONENT,
  CLAIMS_ACTIVE_COMPONENT,
  CLAIMS_PROJECTION_COMPONENT,
] as const satisfies readonly DataComponent[];

export const CLAIM_SOURCE_COMPONENTS = [
  INTENT_FROM_SCANNER_COMPONENT,
  INTENT_FROM_HOOKS_COMPONENT,
  LANDED_FROM_DISK_COMPONENT,
] as const satisfies readonly DataComponent[];

export const ALL_DATA_COMPONENTS = [
  RAW_SCANNER_COMPONENT,
  ...CLAIM_DATA_COMPONENTS,
] as const satisfies readonly DataComponent[];

const DATA_VERSIONS_SQL = `
CREATE TABLE IF NOT EXISTS data_versions (
  component TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_data_versions_updated
  ON data_versions(updated_at_ms);
`;

function tableExists(db: Database, table: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
    .get(table);
}

function tableHasRows(db: Database, table: string): boolean {
  if (!tableExists(db, table)) return false;
  return !!db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
}

function hasAnySessionData(db: Database): boolean {
  return [
    "sessions",
    "messages",
    "tool_calls",
    "hook_events",
    "scanner_turns",
    "scanner_events",
  ].some((table) => tableHasRows(db, table));
}

export function targetDataVersion(component: DataComponent): number {
  return DATA_COMPONENT_VERSIONS[component];
}

export function ensureDataVersionsTable(db: Database): void {
  db.exec(DATA_VERSIONS_SQL);
}

export function readDataVersion(
  db: Database,
  component: DataComponent,
): number | null {
  ensureDataVersionsTable(db);
  const row = db
    .prepare(`SELECT version FROM data_versions WHERE component = ?`)
    .get(component) as { version: number } | undefined;
  return row?.version ?? null;
}

export function writeDataVersion(
  db: Database,
  component: DataComponent,
  version: number,
): void {
  ensureDataVersionsTable(db);
  db.prepare(
    `INSERT INTO data_versions (component, version, updated_at_ms)
     VALUES (?, ?, ?)
     ON CONFLICT(component) DO UPDATE SET
       version = excluded.version,
       updated_at_ms = excluded.updated_at_ms`,
  ).run(component, version, Date.now());
}

export function markDataComponentsCurrentInDb(
  db: Database,
  components: readonly DataComponent[],
): void {
  for (const component of components) {
    writeDataVersion(db, component, targetDataVersion(component));
  }
}

export function markDataComponentsStaleInDb(
  db: Database,
  components: readonly DataComponent[],
  staleVersion = 0,
): void {
  for (const component of components) {
    writeDataVersion(db, component, staleVersion);
  }
}

export function ensureDataVersionsInitialized(db: Database): void {
  ensureDataVersionsTable(db);
  const hasSessionData = hasAnySessionData(db);
  for (const component of ALL_DATA_COMPONENTS) {
    if (readDataVersion(db, component) !== null) continue;
    writeDataVersion(
      db,
      component,
      hasSessionData ? 0 : targetDataVersion(component),
    );
  }
}

export function staleDataComponentsInDb(db: Database): DataComponent[] {
  ensureDataVersionsInitialized(db);
  return ALL_DATA_COMPONENTS.filter((component) => {
    const version = readDataVersion(db, component);
    return version === null || version < targetDataVersion(component);
  });
}
