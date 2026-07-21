#!/usr/bin/env node
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ConsoleClassroomOutput, systemSpeakerForPlatform } from "./adapters/classroom-output";
import { FixtureSensorAdapter } from "./adapters/fixture-sensor";
import { TeacherBrainDemoSensorAdapter } from "./adapters/teacher-brain-demo-sensor";
import { JsonLineSensorAdapter, parseCommandSpec } from "./adapters/json-line-sensor";
import { ControlServer } from "./control/control-server";
import { TutorRuntime } from "./core/tutor-runtime";
import type { ClassroomOutputAdapter, SensorAdapter } from "./core/types";
import { createTutorProviderFromEnvironment } from "./reasoning/tutor-provider";
import { TeacherBrainTutorProvider } from "./reasoning/teacher-brain-provider";
import { LocalEventStore, newSessionRecord } from "./storage/local-event-store";

const command = process.argv[2] ?? "help";
const flags = new Set(process.argv.slice(3));
const dataDirectory = path.resolve(process.env.CC_DATA_DIR ?? ".classroom-compass");
const controlPort = Number(process.env.CC_CONTROL_PORT ?? 4317);

function sessionId(mode: "live" | "demo") {
  return `session-${mode}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

async function runDemo() {
  const id = sessionId("demo");
  const store = new LocalEventStore(dataDirectory, newSessionRecord(id, "demo"));
  const boardMode = flags.has("--board");
  const sensor = new FixtureSensorAdapter(id, flags.has("--fast") ? 1 : boardMode ? 1_500 : 80, true);
  const output = flags.has("--audio") ? systemSpeakerForPlatform() : new ConsoleClassroomOutput(false);
  const runtime = new TutorRuntime(store, [sensor], output);
  const control = boardMode ? new ControlServer(runtime, controlPort) : null;
  await control?.start();
  if (boardMode) process.stdout.write(`Projector scene available at http://127.0.0.1:${controlPort}/board (open http://localhost:3000/board after starting npm run board:dev)\n`);
  await runtime.start({ stopWhenSensorsComplete: !boardMode });
  const record = runtime.snapshot();
  process.stdout.write(`\nDemo complete\n`);
  process.stdout.write(`Events: ${record.events.length}\nCommands: ${record.commands.length}\nEvidence: ${record.evidence.length}\nRaw media retained: ${record.rawMediaRetainedBytes} bytes\n`);
  process.stdout.write(`Session record: ${store.filePath}\n`);
  if (record.evidence[0]) process.stdout.write(`Observed result: ${record.evidence[0].statement}\n`);
  if (boardMode) {
    process.stdout.write("Excalidraw demo remains available until Ctrl-C.\n");
    await new Promise<void>((resolve) => {
      const finish = () => resolve();
      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
    });
    await runtime.stop("Board demo ended.");
    await control?.close();
  }
}

async function runTeacherBrainDemo() {
  const id = sessionId("demo");
  const lessonTitle = process.env.CC_LESSON_TITLE ?? "Equivalent Fractions";
  const demoEnvironment = {
    ...process.env,
    CC_TUTOR_PROVIDER: "teacher-brain",
    CC_TEACHER_BRAIN_ROSTER_JSON: process.env.CC_TEACHER_BRAIN_ROSTER_JSON ?? JSON.stringify([
      { studentRef: "seat-english", name: "Jordan", language: "English" },
      { studentRef: "seat-spanish", name: "Sofia", language: "Spanish" },
      { studentRef: "seat-quiet", name: "Riley", language: "English" },
    ]),
  };
  const provider = createTutorProviderFromEnvironment(demoEnvironment);
  if (!(provider instanceof TeacherBrainTutorProvider)) {
    throw new Error("The Teacher Brain demo requires the Teacher Brain provider.");
  }
  const roster = provider.roster();
  const englishStudent = roster.find((student) => provider.languageForStudent(student.studentRef) === "en");
  const spanishStudent = roster.find((student) => provider.languageForStudent(student.studentRef) === "es");
  if (!englishStudent || !spanishStudent) {
    throw new Error("The Teacher Brain demo roster must contain English- and Spanish-speaking students.");
  }

  const store = new LocalEventStore(dataDirectory, newSessionRecord(id, "demo", lessonTitle));
  const boardMode = flags.has("--board");
  const sensor = new TeacherBrainDemoSensorAdapter(
    id,
    englishStudent.studentRef,
    spanishStudent.studentRef,
    flags.has("--fast") ? 1 : 900,
  );
  const output = flags.has("--quiet") ? new ConsoleClassroomOutput(false) : systemSpeakerForPlatform();
  const runtime = new TutorRuntime(store, [sensor], output, provider);
  const control = boardMode ? new ControlServer(runtime, controlPort) : null;
  await control?.start();
  if (boardMode) {
    process.stdout.write("Open http://localhost:3000/board for the Visual Stage or http://localhost:3000/board/excalidraw for the editable canvas.\n");
  }
  await runtime.start({ stopWhenSensorsComplete: !boardMode });

  const record = runtime.snapshot();
  const apiSession = provider.classroomSessionId();
  const apiBaseUrl = provider.apiBaseUrl();
  process.stdout.write("\nTeacher Brain demo complete\n");
  process.stdout.write(`Opening/resume transitions: ${record.audit.filter((entry) => ["lesson_started", "lesson_resumed"].includes(entry.action)).length}\n`);
  process.stdout.write(`Student interruptions: ${record.events.filter((event) => event.kind === "question_transcribed").length}\n`);
  process.stdout.write(`Public board scenes: ${record.commands.filter((item) => item.kind === "hardware_visual").length}\n`);
  process.stdout.write(`Raw media retained: ${record.rawMediaRetainedBytes} bytes\n`);
  process.stdout.write(`Local session record: ${store.filePath}\n`);
  if (apiSession) {
    process.stdout.write(`Teacher Brain session: ${apiSession}\n`);
    for (const student of roster) {
      process.stdout.write(`Memory: ${apiBaseUrl}/api/teacher/students/${encodeURIComponent(student.name)}/memory\n`);
    }
    process.stdout.write(`Participation suggestion: ${apiBaseUrl}/api/teacher/sessions/${encodeURIComponent(apiSession)}/participation-recommendation\n`);
  }

  if (boardMode) {
    process.stdout.write("The projector remains available until Ctrl-C.\n");
    await new Promise<void>((resolve) => {
      const finish = () => resolve();
      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
    });
    await runtime.stop("Teacher Brain board demo ended.");
    await control?.close();
  }
}

async function runService() {
  const id = sessionId("live");
  const store = new LocalEventStore(dataDirectory, newSessionRecord(id, "live", process.env.CC_LESSON_TITLE ?? "Open Classroom Questions"));
  const cameraCommand = parseCommandSpec(process.env.CC_CAMERA_COMMAND_JSON);
  const microphoneCommand = parseCommandSpec(process.env.CC_MICROPHONE_COMMAND_JSON);
  const sensors: SensorAdapter[] = [];
  if (cameraCommand) sensors.push(new JsonLineSensorAdapter("local-camera-pipeline@1.0.0", id, cameraCommand));
  if (microphoneCommand) sensors.push(new JsonLineSensorAdapter("local-microphone-transcriber@1.0.0", id, microphoneCommand));
  if (sensors.length === 0) sensors.push(new JsonLineSensorAdapter("stdin-sensor-bridge@1.0.0", id));
  const output: ClassroomOutputAdapter = process.env.CC_AUDIO_OUTPUT === "system" || flags.has("--audio")
    ? systemSpeakerForPlatform()
    : new ConsoleClassroomOutput(false);
  const tutorProvider = createTutorProviderFromEnvironment(process.env);
  const runtime = new TutorRuntime(store, sensors, output, tutorProvider);
  const control = new ControlServer(runtime, controlPort);
  await control.start();
  process.stdout.write(`Classroom Compass headless service listening on 127.0.0.1:${controlPort}\n`);
  process.stdout.write(`Session: ${id}\nRaw media retention: 0 bytes\n`);
  process.stdout.write(`Tutor provider: ${tutorProvider?.id ?? "disabled (reviewed tools only)"}\n`);
  const shutdown = async (signal: string) => {
    await runtime.stop(`${signal} received.`);
    await control.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  await runtime.start({ stopWhenSensorsComplete: process.env.CC_STOP_WHEN_SENSORS_COMPLETE === "1" });
  await control.close();
}

async function requestControl(method: string, endpoint: string) {
  const response = await fetch(`http://127.0.0.1:${controlPort}${endpoint}`, { method });
  if (!response.ok) throw new Error(`Control service returned ${response.status}`);
  process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`);
}

async function exportLatest() {
  try {
    return await requestControl("GET", "/session");
  } catch {
    await mkdir(dataDirectory, { recursive: true });
    const files = (await readdir(dataDirectory)).filter((file) => file.endsWith(".json")).sort();
    const latest = files.at(-1);
    if (!latest) throw new Error("No session record found.");
    process.stdout.write(await readFile(path.join(dataDirectory, latest), "utf8"));
  }
}

function showHelp() {
  process.stdout.write(`Classroom Compass — headless classroom tutor\n\n`);
  process.stdout.write(`Commands:\n`);
  process.stdout.write(`  npm run tutor -- demo [--fast] [--audio] [--board]  Run the complete deterministic decimal lesson\n`);
  process.stdout.write(`  npm run tutor -- teacher-demo [--fast] [--quiet] [--board]  Rehearse the audible bilingual Teacher Brain flow\n`);
  process.stdout.write(`  npm run tutor -- run [--audio]            Run the background service\n`);
  process.stdout.write(`  npm run tutor -- health                   Read local service health\n`);
  process.stdout.write(`  npm run tutor -- pause|resume|stop        Control sensing and output\n`);
  process.stdout.write(`  npm run tutor -- export                   Print the active or latest session record\n`);
  process.stdout.write(`  npm run tutor -- delete --yes             Delete the active session record\n\n`);
  process.stdout.write(`Live sensor integration:\n`);
  process.stdout.write(`  CC_CAMERA_COMMAND_JSON='["/path/to/local-camera-adapter"]'\n`);
  process.stdout.write(`  CC_MICROPHONE_COMMAND_JSON='["/path/to/local-transcriber"]'\n`);
  process.stdout.write(`Each adapter writes one validated event JSON object per stdout line. Without adapters, run mode accepts those JSON lines on stdin.\n`);
  process.stdout.write(`\nProjector output:\n  npm run board:dev    Serve the local Excalidraw projector at http://localhost:3000/board\n`);
}

try {
  if (command === "demo") await runDemo();
  else if (command === "teacher-demo") await runTeacherBrainDemo();
  else if (command === "run") await runService();
  else if (command === "health") await requestControl("GET", "/health");
  else if (command === "pause") await requestControl("POST", "/pause");
  else if (command === "resume") await requestControl("POST", "/resume");
  else if (command === "stop") await requestControl("POST", "/stop");
  else if (command === "export") await exportLatest();
  else if (command === "delete") {
    if (!flags.has("--yes")) throw new Error("Deletion requires --yes.");
    await requestControl("DELETE", "/session");
  } else showHelp();
} catch (error) {
  process.stderr.write(`Classroom Compass error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
