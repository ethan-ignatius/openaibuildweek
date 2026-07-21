import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HeadlessEvent, ObservedEvidence, SessionRecord, TutorCommand } from "../core/types";

export class LocalEventStore {
  private record: SessionRecord;
  private writeQueue: Promise<void> = Promise.resolve();
  readonly filePath: string;

  constructor(private directory: string, initial: SessionRecord) {
    this.record = initial;
    this.filePath = path.join(directory, `${initial.sessionId}.json`);
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true });
    try {
      this.record = JSON.parse(await readFile(this.filePath, "utf8")) as SessionRecord;
    } catch {
      await this.flush();
    }
  }

  snapshot() {
    return structuredClone(this.record);
  }

  update(mutator: (record: SessionRecord) => void) {
    const operation = this.writeQueue.then(async () => {
      mutator(this.record);
      await this.flush();
    });
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  async appendEvent(event: HeadlessEvent) {
    await this.update((record) => { record.events.push(event); });
  }

  async appendCommand(command: TutorCommand) {
    await this.update((record) => { record.commands.push(command); });
  }

  async appendEvidence(evidence: ObservedEvidence) {
    await this.update((record) => { record.evidence.push(evidence); });
  }

  async appendAudit(action: string, detail: string) {
    await this.update((record) => { record.audit.push({ id: crypto.randomUUID(), action, at: new Date().toISOString(), detail }); });
  }

  async delete() {
    await this.writeQueue;
    await rm(this.filePath, { force: true });
  }

  private async flush() {
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.record, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }
}

export function newSessionRecord(sessionId: string, mode: "live" | "demo", lessonTitle = "Comparing Decimals"): SessionRecord {
  return {
    schemaVersion: 1,
    sessionId,
    lessonTitle,
    startedAt: new Date().toISOString(),
    mode,
    status: "starting",
    rawMediaRetainedBytes: 0,
    events: [],
    commands: [],
    evidence: [],
    audit: [{ id: crypto.randomUUID(), action: "session_created", at: new Date().toISOString(), detail: `${mode} session created with zero raw-media retention.` }],
  };
}
