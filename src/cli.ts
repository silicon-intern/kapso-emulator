#!/usr/bin/env node
/**
 * Standalone runner: `npx kapso-emulator`. Every option is also readable from
 * a KAPSO_EMULATOR_* environment variable so process managers and dev scripts
 * can configure the emulator without building a flag string; flags win.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createKapsoEmulator } from "./server.js";

const HELP = `kapso-emulator - local Kapso WhatsApp platform emulator

Usage:
  kapso-emulator [options]

Options:
  -p, --port <n>            Listen port (default 4300, 0 picks a free port)
                            env: KAPSO_EMULATOR_PORT
  -u, --webhook-url <url>   Where signed whatsapp.message.* webhooks are POSTed
                            env: KAPSO_EMULATOR_WEBHOOK_URL
  -s, --webhook-secret <s>  HMAC-SHA256 secret for X-Webhook-Signature
                            env: KAPSO_EMULATOR_WEBHOOK_SECRET
      --echo-delay <ms>     Delay before a send echoes back as message.sent
                            (default 300) env: KAPSO_EMULATOR_ECHO_DELAY_MS
      --api-key <key>       Pin the accepted X-API-Key; unset accepts any
                            non-empty key. env: KAPSO_EMULATOR_API_KEY
      --state-file <path>   Persist and restore state across restarts
                            env: KAPSO_EMULATOR_STATE_FILE
  -h, --help                Show this help
  -v, --version             Print the version

Without --webhook-url and --webhook-secret the emulator still serves the API
surfaces, but injected inbound messages and sent echoes have nowhere to go.
`;

function fail(message: string): never {
  console.error(`kapso-emulator: ${message}`);
  console.error("Run kapso-emulator --help for usage.");
  process.exit(1);
}

function numberOption(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) fail(`${name} must be a non-negative number`);
  return parsed;
}

let values: {
  port?: string;
  "webhook-url"?: string;
  "webhook-secret"?: string;
  "echo-delay"?: string;
  "api-key"?: string;
  "state-file"?: string;
  help?: boolean;
  version?: boolean;
};
try {
  ({ values } = parseArgs({
    options: {
      port: { type: "string", short: "p" },
      "webhook-url": { type: "string", short: "u" },
      "webhook-secret": { type: "string", short: "s" },
      "echo-delay": { type: "string" },
      "api-key": { type: "string" },
      "state-file": { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  }));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

if (values.help) {
  console.log(HELP);
  process.exit(0);
}
if (values.version) {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  console.log(manifest.version);
  process.exit(0);
}

const env = process.env;
const emulator = await createKapsoEmulator({
  port: numberOption(values.port ?? env.KAPSO_EMULATOR_PORT, "--port") ?? 4300,
  webhook: {
    url: values["webhook-url"] ?? env.KAPSO_EMULATOR_WEBHOOK_URL,
    secret: values["webhook-secret"] ?? env.KAPSO_EMULATOR_WEBHOOK_SECRET,
  },
  echo_delay_ms:
    numberOption(values["echo-delay"] ?? env.KAPSO_EMULATOR_ECHO_DELAY_MS, "--echo-delay") ?? 300,
  api_key: values["api-key"] ?? env.KAPSO_EMULATOR_API_KEY ?? undefined,
  state_file: values["state-file"] ?? env.KAPSO_EMULATOR_STATE_FILE ?? undefined,
});

console.log(`KAPSO_EMULATOR_LISTENING ${emulator.url}`);
console.log(`  meta proxy    ${emulator.url}/meta/whatsapp`);
console.log(`  platform api  ${emulator.url}/platform/v1`);
console.log(`  simulator     ${emulator.url}/_kapso/simulate`);
console.log(`  inspector     ${emulator.url}/`);
if (!(values["webhook-url"] ?? env.KAPSO_EMULATOR_WEBHOOK_URL)) {
  console.warn(
    "[kapso-emulator] no webhook target configured - inbound injects and sent echoes will be dropped (set --webhook-url and --webhook-secret)",
  );
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void emulator.close().finally(() => process.exit(0));
  });
}
