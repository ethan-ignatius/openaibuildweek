import { createServer, type Server, type ServerResponse } from "node:http";
import type { TutorRuntime } from "../core/tutor-runtime";

export class ControlServer {
  private server: Server | null = null;
  constructor(private runtime: TutorRuntime, private port = 4317, private host = "127.0.0.1") {}

  async start() {
    await new Promise<void>((resolve, reject) => {
      this.server = createServer(async (request, response) => {
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Cache-Control", "no-store");
        const method = request.method ?? "GET";
        const path = new URL(request.url ?? "/", `http://${this.host}:${this.port}`).pathname;
        try {
          if (method === "GET" && path === "/health") return this.send(response, 200, this.runtime.health());
          if (method === "GET" && path === "/session") return this.send(response, 200, this.runtime.snapshot());
          if (method === "GET" && path === "/board") {
            response.setHeader("Access-Control-Allow-Origin", "*");
            return this.send(response, 200, this.runtime.publicBoardState());
          }
          if (method === "POST" && path === "/pause") { await this.runtime.pause("Local control command."); return this.send(response, 200, this.runtime.health()); }
          if (method === "POST" && path === "/resume") { await this.runtime.resume(); return this.send(response, 200, this.runtime.health()); }
          if (method === "POST" && path === "/stop") { await this.runtime.stop("Local control command."); return this.send(response, 200, this.runtime.health()); }
          if (method === "DELETE" && path === "/session") { await this.runtime.deleteSession(); return this.send(response, 200, { deleted: true }); }
          return this.send(response, 404, { error: "Not found" });
        } catch (error) {
          return this.send(response, 500, { error: error instanceof Error ? error.message : "Control request failed" });
        }
      });
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => resolve());
    });
  }

  async close() {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => this.server?.close((error) => error ? reject(error) : resolve()));
    this.server = null;
  }

  private send(response: ServerResponse, status: number, body: unknown) {
    response.statusCode = status;
    response.end(`${JSON.stringify(body, null, 2)}\n`);
  }
}
