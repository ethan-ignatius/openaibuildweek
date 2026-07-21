import { resetState, readState, writeState } from "../../../db/state-store";
import { toPublicDisplayState } from "../../../privacy/public-state";
import type { AppState } from "../../../domain/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const state = await readState();
    const publicOnly = new URL(request.url).searchParams.get("public") === "1";
    return Response.json(publicOnly ? toPublicDisplayState(state) : state, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "State unavailable" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const state = await request.json() as AppState;
    if (state.schemaVersion !== 1 || state.classroom?.fictional !== true) {
      return Response.json({ error: "Invalid demo state" }, { status: 400 });
    }
    return Response.json(await writeState(state));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to save" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    return Response.json(await resetState());
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to reset" }, { status: 500 });
  }
}
