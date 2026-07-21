import { createInitialState } from "../demo/fixtures";
import type { AppState } from "../domain/types";

const STATE_ID = "classroom-compass-demo";
const memoryStore = globalThis as typeof globalThis & { __classroomCompassDemoState?: AppState };

async function database(): Promise<D1Database | null> {
  if (typeof process !== "undefined" && process.env.NODE_ENV === "development") return null;
  const { env } = await import("cloudflare:workers");
  if (!env.DB) throw new Error("D1 binding DB is unavailable");
  return env.DB;
}

async function ensureTables(db: D1Database) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS app_state (id TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
    db.prepare("CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
  ]);
}

export async function readState(): Promise<AppState> {
  const db = await database();
  if (!db) {
    memoryStore.__classroomCompassDemoState ??= createInitialState();
    return memoryStore.__classroomCompassDemoState;
  }
  await ensureTables(db);
  const row = await db.prepare("SELECT json FROM app_state WHERE id = ?").bind(STATE_ID).first<{ json: string }>();
  if (row?.json) return JSON.parse(row.json) as AppState;
  const initial = createInitialState();
  await writeState(initial);
  return initial;
}

export async function writeState(state: AppState): Promise<AppState> {
  const db = await database();
  if (!db) {
    memoryStore.__classroomCompassDemoState = state;
    return state;
  }
  await ensureTables(db);
  await db.prepare("INSERT INTO app_state (id, json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = CURRENT_TIMESTAMP")
    .bind(STATE_ID, JSON.stringify(state))
    .run();
  return state;
}

export async function resetState() {
  const state = createInitialState();
  return writeState(state);
}
