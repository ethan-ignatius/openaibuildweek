import { createReasoningProviderFromEnvironment, proposeWithFallback } from "../../../services/reasoning/provider";
import type { ClassroomEvent } from "../../../domain/types";

export async function POST(request: Request) {
  const body = await request.json() as { lessonTopic?: string; transcript?: string; recentEvents?: ClassroomEvent[] };
  if (!body.lessonTopic || !body.transcript) return Response.json({ error: "lessonTopic and transcript are required" }, { status: 400 });
  const provider = createReasoningProviderFromEnvironment(process.env);
  const proposal = await proposeWithFallback({ lessonTopic: body.lessonTopic, transcript: body.transcript, recentEvents: body.recentEvents ?? [] }, provider);
  return Response.json({ proposal, provider: provider.id, fallbackAvailable: true });
}
