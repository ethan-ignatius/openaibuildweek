import { readState } from "../../../db/state-store";

export async function GET() {
  const state = await readState();
  return new Response(JSON.stringify(state, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": "attachment; filename=classroom-compass-demo-export.json",
      "Cache-Control": "no-store",
    },
  });
}
