import { env } from "cloudflare:workers";
import { createInitialState } from "../demo/fixtures";
import type { AppState } from "../domain/types";

const STATE_ID = "classroom-compass-demo";

async function ensureTables() {
  if (!env.DB) throw new Error("D1 binding DB is unavailable");
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS app_state (id TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
  ]);
}

export async function readState(): Promise<AppState> {
  await ensureTables();
  const row = await env.DB.prepare("SELECT json FROM app_state WHERE id = ?").bind(STATE_ID).first<{ json: string }>();
  if (row?.json) return JSON.parse(row.json) as AppState;
  const initial = createInitialState();
  await writeState(initial);
  return initial;
}

export async function writeState(state: AppState): Promise<AppState> {
  await ensureTables();
  await env.DB.prepare("INSERT INTO app_state (id, json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = CURRENT_TIMESTAMP")
    .bind(STATE_ID, JSON.stringify(state))
    .run();
  return state;
}

export async function resetState() {
  const state = createInitialState();
  return writeState(state);
}
