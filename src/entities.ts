import type { Entity } from "@emulators/core";

export type KapsoMessageDirection = "inbound" | "outbound";

/**
 * The Meta message types the emulator understands end to end. Anything else
 * hitting the messages endpoint is refused with a loud 501 so gaps surface
 * immediately instead of silently dropping traffic.
 */
export const SUPPORTED_MESSAGE_TYPES = [
  "text",
  "template",
  "interactive",
  "image",
  "audio",
  "video",
  "document",
  "sticker",
] as const;
export type SupportedMessageType = (typeof SUPPORTED_MESSAGE_TYPES)[number];

export const MEDIA_MESSAGE_TYPES = ["image", "audio", "video", "document", "sticker"] as const;
export type MediaMessageType = (typeof MEDIA_MESSAGE_TYPES)[number];

export interface KapsoConversation extends Entity {
  /** Stable thread key: `${phone_number_id}:${customer_phone}`. */
  conversation_key: string;
  /** The rotating transport id Kapso exposes; rotate-conversation mints a new one. */
  kapso_conversation_id: string;
  phone_number_id: string;
  customer_phone: string;
  contact_name: string | null;
  active: boolean;
}

export interface KapsoMessage extends Entity {
  wamid: string;
  phone_number_id: string;
  customer_phone: string;
  kapso_conversation_id: string;
  direction: KapsoMessageDirection;
  message_type: string;
  /** Kapso-normalized display text: body, template marker, list body, caption. */
  content: string | null;
  /**
   * The substituted template body (+ footer) for a template send whose
   * definition the emulator knows. Mirrors real Kapso, where the webhook echo
   * carries only the marker while the Platform listing returns the rendered
   * text (what template rehydration reads). Null when the template is not in
   * the local registry.
   */
  rendered_content: string | null;
  template_name: string | null;
  template_params: string[] | null;
  media_id: string | null;
  media_content_type: string | null;
  media_filename: string | null;
  caption: string | null;
  /** The raw send payload (snake_case, as received) for inspection. */
  payload: unknown;
}

/**
 * A WABA message template created through the Meta proxy. The emulator
 * approves instantly (real Meta review takes ~24h, which a local loop must
 * not wait on) unless a template_review failure rule is active; the stored
 * components carry the BODY/FOOTER text used to render broadcast sends and
 * platform listing rows.
 */
export interface KapsoTemplate extends Entity {
  template_id: string;
  waba_id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  /** Meta reports the literal "NONE" while a template is not rejected. */
  rejected_reason: string;
  components: Array<Record<string, unknown>>;
}

/**
 * A connected WhatsApp phone number, as the Platform API reports it. Real
 * Kapso provisions numbers through its hosted setup link, which this emulator
 * does not emulate, so a number is REGISTERED ON FIRST LOOKUP from its id —
 * the same posture `ensureConversation` takes for a thread. Its WABA id is
 * DERIVED from the number id so the pairing is stable across restarts and a
 * template created under the resolved WABA stays retrievable by the same
 * caller.
 */
export interface KapsoPhoneNumber extends Entity {
  phone_number_id: string;
  display_phone_number: string;
  verified_name: string;
  waba_id: string;
  status: string;
}

export const BROADCAST_STATUSES = ["draft", "sending", "completed", "failed"] as const;
export type KapsoBroadcastStatus = (typeof BROADCAST_STATUSES)[number];

export const BROADCAST_RECIPIENT_STATUSES = [
  "pending",
  "sent",
  "delivered",
  "read",
  "responded",
  "failed",
] as const;
export type KapsoBroadcastRecipientStatus = (typeof BROADCAST_RECIPIENT_STATUSES)[number];

/** A Platform API broadcast: one template fanned out to a recipient list. */
export interface KapsoBroadcast extends Entity {
  broadcast_id: string;
  name: string;
  phone_number_id: string;
  whatsapp_template_id: string;
  status: KapsoBroadcastStatus;
  started_at: string | null;
  completed_at: string | null;
}

export interface KapsoBroadcastRecipient extends Entity {
  recipient_id: string;
  broadcast_id: string;
  /** Digits-only, like every other phone in the store. */
  phone_number: string;
  status: KapsoBroadcastRecipientStatus;
  /** Per-recipient template parameter components, as attached. */
  components: Array<Record<string, unknown>> | null;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  responded_at: string | null;
  error_message: string | null;
}

export interface KapsoMediaAsset extends Entity {
  media_id: string;
  content_type: string;
  file_name: string | null;
  data_base64: string;
  byte_size: number;
}

export interface KapsoWebhookDeliveryLog extends Entity {
  event: string;
  url: string;
  wamid: string | null;
  status_code: number | null;
  success: boolean;
  error: string | null;
}

export interface KapsoSimulatorEvent extends Entity {
  seq: number;
  kind: string;
  phone_number_id: string;
  customer_phone: string | null;
  data: Record<string, unknown>;
}

export interface KapsoEmulatorSettings {
  /** Where signed whatsapp.message.* webhooks are POSTed (the consuming API). */
  webhook_url: string | null;
  /** HMAC-SHA256 secret for X-Webhook-Signature over the raw body. */
  webhook_secret: string | null;
  /** Delay before an accepted outbound send echoes back as message.sent. */
  echo_delay_ms: number;
  /** When set, X-API-Key must equal it; when null any non-empty key passes. */
  api_key: string | null;
  /** Advertised origin used to mint media download URLs in webhook payloads. */
  base_url: string;
}
