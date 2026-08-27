import type { AddressInfo } from "node:net";
import {
  type AppEnv,
  cors,
  filePersistence,
  Hono,
  Store,
  serve,
  WebhookDispatcher,
} from "@emulators/core";
import { type KapsoSeedConfig, kapsoPlugin, seedFromConfig } from "./index.js";
import { getSettings, resetKapsoState, setSettings } from "./store.js";

const STATE_SAVE_INTERVAL_MS = 2_000;

export interface KapsoEmulatorOptions extends KapsoSeedConfig {
  /** 0 picks an ephemeral port; the resolved URL is on the returned handle. */
  port?: number;
  /**
   * Snapshot the store to this file (core's filePersistence) and restore it
   * on boot. Without it, state — including media blobs backing persisted
   * media URLs — dies with the process, so a consuming app's stored
   * transcript would reference media this emulator no longer has.
   */
  state_file?: string;
}

export interface KapsoEmulator {
  url: string;
  store: Store;
  reset(): void;
  close(): Promise<void>;
}

/**
 * Boot a standalone Kapso emulator. Deliberately assembled without core's
 * createServer: that wrapper meters anonymous requests against a shared
 * hourly rate bucket, which an interactive chat UI polling for typing events
 * would exhaust mid-session. The Kapso routes carry their own X-API-Key
 * checks, so the core auth middleware adds nothing here.
 */
export async function createKapsoEmulator(
  options: KapsoEmulatorOptions = {},
): Promise<KapsoEmulator> {
  const app = new Hono<AppEnv>();
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  app.use("*", cors());
  // Anything a route failed to model must still answer JSON and leave a
  // trace: a bare-text 500 breaks consumers that res.json() every response,
  // and a silent one is undebuggable.
  app.onError((error, c) => {
    console.error("[kapso-emulator] unhandled error", error);
    return c.json(
      { error: { message: error instanceof Error ? error.message : String(error) } },
      500,
    );
  });
  kapsoPlugin.register(app, store, webhooks, "http://localhost:0");

  // Restore BEFORE listening (a request racing the restore would see empty
  // state and then be wiped by it) and BEFORE seeding (the seed re-applies
  // the current wiring — webhook target, base URL, delays — over whatever
  // settings the snapshot carried).
  const persistence = options.state_file ? filePersistence(options.state_file) : null;
  let lastSavedSnapshot = "";
  if (persistence) {
    const saved = await persistence.load();
    if (saved) {
      try {
        store.restore(JSON.parse(saved));
        lastSavedSnapshot = saved;
      } catch (error) {
        console.warn("[kapso-emulator] could not restore state file; starting fresh", error);
      }
    }
  }

  const server = serve({ fetch: app.fetch, port: options.port ?? 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  const url = `http://localhost:${address.port}`;

  seedFromConfig(store, url, options);
  const seededSettings = getSettings(store);

  const saveIfChanged = async (): Promise<void> => {
    if (!persistence) return;
    const snapshot = JSON.stringify(store.snapshot());
    if (snapshot === lastSavedSnapshot) return;
    lastSavedSnapshot = snapshot;
    await persistence.save(snapshot).catch((error) => {
      console.warn("[kapso-emulator] state save failed", error);
    });
  };
  const saveTimer = persistence
    ? setInterval(() => void saveIfChanged(), STATE_SAVE_INTERVAL_MS)
    : null;
  if (saveTimer && typeof saveTimer.unref === "function") saveTimer.unref();

  return {
    url,
    store,
    reset(): void {
      resetKapsoState(store);
      setSettings(store, seededSettings);
      void saveIfChanged();
    },
    close(): Promise<void> {
      if (saveTimer) clearInterval(saveTimer);
      return new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          void saveIfChanged().then(resolve);
        });
      });
    },
  };
}
