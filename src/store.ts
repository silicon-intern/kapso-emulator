import type { Collection, Store } from "@emulators/core";
import type {
  KapsoBroadcast,
  KapsoBroadcastRecipient,
  KapsoConversation,
  KapsoEmulatorSettings,
  KapsoMediaAsset,
  KapsoMessage,
  KapsoPhoneNumber,
  KapsoSimulatorEvent,
  KapsoTemplate,
  KapsoWebhookDeliveryLog,
} from "./entities.js";

export interface KapsoStore {
  conversations: Collection<KapsoConversation>;
  messages: Collection<KapsoMessage>;
  media: Collection<KapsoMediaAsset>;
  phoneNumbers: Collection<KapsoPhoneNumber>;
  templates: Collection<KapsoTemplate>;
  broadcasts: Collection<KapsoBroadcast>;
  broadcastRecipients: Collection<KapsoBroadcastRecipient>;
  webhookDeliveries: Collection<KapsoWebhookDeliveryLog>;
  events: Collection<KapsoSimulatorEvent>;
}

const SETTINGS_KEY = "kapso.settings";
const EVENT_SEQ_KEY = "kapso.event_seq";

export function getKapsoStore(store: Store): KapsoStore {
  return {
    conversations: store.collection<KapsoConversation>("kapso.conversations", [
      "conversation_key",
      "kapso_conversation_id",
      "phone_number_id",
    ]),
    messages: store.collection<KapsoMessage>("kapso.messages", [
      "wamid",
      "phone_number_id",
      "customer_phone",
      "kapso_conversation_id",
      "direction",
    ]),
    media: store.collection<KapsoMediaAsset>("kapso.media", ["media_id"]),
    phoneNumbers: store.collection<KapsoPhoneNumber>("kapso.phone_numbers", [
      "phone_number_id",
      "waba_id",
    ]),
    templates: store.collection<KapsoTemplate>("kapso.templates", [
      "template_id",
      "waba_id",
      "name",
    ]),
    broadcasts: store.collection<KapsoBroadcast>("kapso.broadcasts", ["broadcast_id", "status"]),
    broadcastRecipients: store.collection<KapsoBroadcastRecipient>("kapso.broadcast_recipients", [
      "broadcast_id",
      "phone_number",
      "status",
    ]),
    webhookDeliveries: store.collection<KapsoWebhookDeliveryLog>("kapso.webhook_deliveries", [
      "event",
    ]),
    events: store.collection<KapsoSimulatorEvent>("kapso.events", ["kind", "phone_number_id"]),
  };
}

export function getSettings(store: Store): KapsoEmulatorSettings {
  return (
    store.getData<KapsoEmulatorSettings>(SETTINGS_KEY) ?? {
      webhook_url: null,
      webhook_secret: null,
      echo_delay_ms: 300,
      api_key: null,
      base_url: "http://localhost:4300",
    }
  );
}

export function setSettings(store: Store, settings: KapsoEmulatorSettings): void {
  store.setData(SETTINGS_KEY, settings);
}

export function nextEventSeq(store: Store): number {
  const next = (store.getData<number>(EVENT_SEQ_KEY) ?? 0) + 1;
  store.setData(EVENT_SEQ_KEY, next);
  return next;
}
