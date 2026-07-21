import type { ClassroomEvent } from "../../domain/types";

export interface TranscriptAdapter {
  id: string;
  start(onEvent: (event: ClassroomEvent) => void): Promise<void>;
  stop(): void;
}

export interface HandRaiseAdapter {
  id: string;
  start(onEvent: (event: ClassroomEvent) => void): Promise<void>;
  stop(): void;
}

export function stopMediaStream(stream: MediaStream | null) {
  if (!stream) return 0;
  const tracks = stream.getTracks();
  tracks.forEach((track) => track.stop());
  return tracks.length;
}

export async function requestEphemeralMedia() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Media devices unavailable");
  return navigator.mediaDevices.getUserMedia({ video: true, audio: true });
}

export class FixtureTranscriptAdapter implements TranscriptAdapter {
  id = "fixture-transcript@1.0.0";
  async start() {}
  stop() {}
}

export class FixtureHandRaiseAdapter implements HandRaiseAdapter {
  id = "fixture-hand-raise@1.0.0";
  async start() {}
  stop() {}
}
