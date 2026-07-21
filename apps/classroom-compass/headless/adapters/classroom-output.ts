import { spawn } from "node:child_process";
import type { ClassroomOutputAdapter, TutorCommand } from "../core/types";

export class ConsoleClassroomOutput implements ClassroomOutputAdapter {
  id = "console-classroom-output@1.0.0";
  constructor(private quiet = false, public delivered: TutorCommand[] = []) {}
  async deliver(command: TutorCommand) {
    this.delivered.push(command);
    if (!this.quiet) {
      const prefix = command.kind === "speak" ? "TUTOR" : command.kind.toUpperCase();
      process.stdout.write(`[${prefix}] ${command.text ?? command.toolId ?? ""}\n`);
    }
  }
  async cancel() {}
  async close() {}
}

export class SystemSpeakerOutput implements ClassroomOutputAdapter {
  id = "system-speaker-output@1.0.0";
  private active = new Set<ReturnType<typeof spawn>>();

  constructor(private command: string, private baseArgs: string[] = []) {}

  async deliver(command: TutorCommand) {
    if (command.kind !== "speak" || !command.text) return;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.command, [...this.baseArgs, command.text!], { stdio: "ignore" });
      this.active.add(child);
      child.once("error", reject);
      child.once("exit", () => { this.active.delete(child); resolve(); });
    });
  }

  async cancel() { for (const child of this.active) child.kill("SIGTERM"); this.active.clear(); }
  async close() { await this.cancel(); }
}

export function systemSpeakerForPlatform() {
  if (process.platform === "darwin") return new SystemSpeakerOutput("/usr/bin/say");
  return new SystemSpeakerOutput("espeak");
}
