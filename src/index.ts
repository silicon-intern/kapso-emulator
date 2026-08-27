import type {
  AppEnv,
  Hono,
  ServicePlugin,
  Store,
  TokenMap,
  WebhookDispatcher,
} from "@emulators/core";
import { inspectorRoutes } from "./routes/inspector.js";
import { mediaFileRoutes } from "./routes/media.js";
import { messageRoutes, metaProxyFallbackRoutes } from "./routes/messages.js";
import { platformFallbackRoutes, platformRoutes } from "./routes/platform.js";
import { simulatorRoutes } from "./routes/simulator.js";
import { getSettings, setSettings } from "./store.js";

export * from "./entities.js";
export {
  type BroadcastFailureRule,
  clearFailureRules,
  type FailureRules,
  getFailureRules,
  type SendFailureRule,
  setFailureRules,
  type TemplateReviewRule,
} from "./failures.js";
export { createKapsoEmulator, type KapsoEmulator, type KapsoEmulatorOptions } from "./server.js";
export { getKapsoStore, getSettings, type KapsoStore, setSettings } from "./store.js";

export interface KapsoSeedConfig {
  webhook?: {
    /** Target for signed whatsapp.message.* webhooks (the consuming API). */
    url?: string;
    /** Shared HMAC secret; must equal the API's KAPSO_WEBHOOK_SECRET. */
    secret?: string;
  };
  /** Delay before an accepted send echoes back as message.sent (default 300). */
  echo_delay_ms?: number;
  /** Pin the accepted X-API-Key; unset accepts any non-empty key. */
  api_key?: string;
}

export function seedFromConfig(store: Store, baseUrl: string, config: KapsoSeedConfig): void {
  const current = getSettings(store);
  setSettings(store, {
    webhook_url: config.webhook?.url ?? current.webhook_url,
    webhook_secret: config.webhook?.secret ?? current.webhook_secret,
    echo_delay_ms: config.echo_delay_ms ?? current.echo_delay_ms,
    api_key: config.api_key ?? current.api_key,
    base_url: baseUrl || current.base_url,
  });
}

export const kapsoPlugin: ServicePlugin = {
  name: "kapso",
  register(
    app: Hono<AppEnv>,
    store: Store,
    _webhooks: WebhookDispatcher,
    baseUrl: string,
    _tokenMap?: TokenMap,
  ): void {
    const ctx = { app, store, webhooks: _webhooks, baseUrl };
    setSettings(store, { ...getSettings(store), base_url: baseUrl });
    messageRoutes(ctx);
    mediaFileRoutes(ctx);
    platformRoutes(ctx);
    simulatorRoutes(ctx);
    inspectorRoutes(ctx);
    // Fallbacks register last so the specific routes above win.
    metaProxyFallbackRoutes(ctx);
    platformFallbackRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    setSettings(store, { ...getSettings(store), base_url: baseUrl });
  },
};

export default kapsoPlugin;
