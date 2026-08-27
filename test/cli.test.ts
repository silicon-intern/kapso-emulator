import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));
// node --import tsx keeps the CLI in ONE process, so signal handling and the
// exit code under test are the CLI's own, not a wrapper's.
const NODE_ARGS = ["--import", "tsx", CLI];

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function run(args: string[]): Promise<RunResult> {
  const child = spawn(process.execPath, [...NODE_ARGS, ...args], {
    cwd: ROOT,
    env: { ...process.env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code] = (await once(child, "close")) as [number | null];
  return { code, stdout, stderr };
}

let server: ChildProcess | undefined;

afterEach(() => {
  server?.kill("SIGKILL");
  server = undefined;
});

describe("cli", () => {
  it("prints usage on --help", async () => {
    const result = await run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("--webhook-url");
  });

  it("prints the package version on --version", async () => {
    const result = await run(["--version"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("rejects a non-numeric --port with a pointer to --help", async () => {
    const result = await run(["--port", "abc"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--port");
    expect(result.stderr).toContain("--help");
  });

  it("boots on an ephemeral port, serves the API, and shuts down cleanly", async () => {
    server = spawn(process.execPath, [...NODE_ARGS, "--port", "0", "--api-key", "cli-test-key"], {
      cwd: ROOT,
      env: { ...process.env },
    });
    let stdout = "";
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`CLI never listened. Output:\n${stdout}`)),
        15_000,
      );
      server?.stdout?.on("data", (chunk) => {
        stdout += chunk;
        const match = stdout.match(/KAPSO_EMULATOR_LISTENING (http:\/\/localhost:\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      server?.on("error", reject);
    });

    const inspector = await fetch(url);
    expect(inspector.status).toBe(200);

    const unauthenticated = await fetch(`${url}/platform/v1/whatsapp/phone_numbers/pn-1`);
    expect(unauthenticated.status).toBe(401);
    const wrongKey = await fetch(`${url}/platform/v1/whatsapp/phone_numbers/pn-1`, {
      headers: { "X-API-Key": "not-the-key" },
    });
    expect(wrongKey.status).toBe(401);
    const authenticated = await fetch(`${url}/platform/v1/whatsapp/phone_numbers/pn-1`, {
      headers: { "X-API-Key": "cli-test-key" },
    });
    expect(authenticated.status).toBe(200);

    server.kill("SIGTERM");
    const [code] = (await once(server, "close")) as [number | null];
    expect(code).toBe(0);
    server = undefined;
  });
});
