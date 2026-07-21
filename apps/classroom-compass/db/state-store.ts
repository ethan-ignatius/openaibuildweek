import { createInitialState } from "../demo/fixtures";
import type { AppState } from "../domain/types";

const STATE_ID = "classroom-compass-demo";
let localState: AppState | null = null;

declare global {
  var __CLASSROOM_COMPASS_D1__: D1Database | undefined;
}

async function d1Binding() {
  // The Cloudflare worker entry injects its request-scoped binding before the
  // app router runs. Local Next.js has no binding and uses the fixture store.
  return globalThis.__CLASSROOM_COMPASS_D1__ ?? null;
}

async function ensureTables() {
  const database = await d1Binding();
  if (!database) return null;
  await database.batch([
    database.prepare("CREATE TABLE IF NOT EXISTS app_state (id TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
    database.prepare("CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
  ]);
  return database;
}

export async function readState(): Promise<AppState> {
  const database = await ensureTables();
  if (!database) {
    localState ??= createInitialState();
    return structuredClone(localState);
  }
  const row = await database.prepare("SELECT json FROM app_state WHERE id = ?").bind(STATE_ID).first<{ json: string }>();
  if (row?.json) return JSON.parse(row.json) as AppState;
  const initial = createInitialState();
  await writeState(initial);
  return initial;
}

export async function writeState(state: AppState): Promise<AppState> {
  const database = await ensureTables();
  if (!database) {
    localState = structuredClone(state);
    return structuredClone(localState);
  }
  await database.prepare("INSERT INTO app_state (id, json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = CURRENT_TIMESTAMP")
    .bind(STATE_ID, JSON.stringify(state))
    .run();
  return state;
}

export async function resetState() {
  const state = createInitialState();
  return writeState(state);
}
