import type {
  KapsoBroadcast,
  KapsoBroadcastRecipient,
  KapsoMediaAsset,
  KapsoMessage,
  KapsoPhoneNumber,
  KapsoTemplate,
} from "./entities.js";
import { digitsOnly, mediaDownloadUrl } from "./helpers.js";

/** Meta Graph API send response: `messages[0].id` is what callers keep. */
export function sendAcceptedResponse(to: string, wamid: string): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    contacts: [{ input: to, wa_id: digitsOnly(to) }],
    messages: [{ id: wamid }],
  };
}

/**
 * Meta media metadata. `url`/`download_url` point at the emulator's own
 * unauthenticated blob route; consumers fetch them like a Meta CDN URL.
 */
export function mediaMetadataResponse(
  baseUrl: string,
  asset: KapsoMediaAsset,
): Record<string, unknown> {
  const url = mediaDownloadUrl(baseUrl, asset.media_id);
  return {
    id: asset.media_id,
    messaging_product: "whatsapp",
    url,
    download_url: url,
    mime_type: asset.content_type,
    file_size: asset.byte_size,
  };
}

/**
 * A WABA template as Meta returns it — ONE definition behind BOTH the listing
 * and the single-template read, because a reconcile that polls a template by
 * id and one that finds it by name must never disagree about the fields it
 * keys on (`status`, `rejected_reason`).
 */
export function templateResponse(template: KapsoTemplate): Record<string, unknown> {
  return {
    id: template.template_id,
    name: template.name,
    status: template.status,
    category: template.category,
    language: template.language,
    components: template.components,
    rejected_reason: template.rejected_reason,
  };
}

/**
 * A Kapso Platform API phone-number row. `whatsapp_business_account_id` is the
 * field consumers read to discover which WABA a number belongs to, which is
 * what makes template create/read reachable from a bare phone number id.
 */
export function platformPhoneNumberRow(phoneNumber: KapsoPhoneNumber): Record<string, unknown> {
  return {
    id: phoneNumber.phone_number_id,
    display_phone_number: phoneNumber.display_phone_number,
    display_phone_number_normalized: digitsOnly(phoneNumber.display_phone_number),
    verified_name: phoneNumber.verified_name,
    status: phoneNumber.status,
    is_coexistence: false,
    whatsapp_business_account_id: phoneNumber.waba_id,
  };
}

/**
 * A Kapso Platform API message row, shaped for template rehydration:
 * consumers read `kapso.message_type_data` (template name + BODY params) and
 * fall back to the normalized content.
 */
export function platformMessageRow(message: KapsoMessage): Record<string, unknown> {
  const templateData =
    message.message_type === "template" && message.template_name
      ? {
          name: message.template_name,
          components: [
            {
              type: "BODY",
              parameters: (message.template_params ?? []).map((text) => ({ type: "text", text })),
            },
          ],
        }
      : null;
  // Real Kapso returns the RENDERED text from the Platform listing (the
  // webhook echo keeps the marker) — template rehydration prefers this
  // content and only falls back to re-rendering when it looks like a marker.
  const displayContent = message.rendered_content ?? message.content ?? "";
  return {
    id: message.wamid,
    direction: message.direction,
    message_type: message.message_type,
    // Consumers commonly DROP rows missing direction, timestamp, or content,
    // so this field is load-bearing, not decoration.
    timestamp: message.created_at,
    content: displayContent,
    text: { body: displayContent },
    kapso: {
      content: displayContent,
      ...(templateData ? { message_type_data: templateData } : {}),
    },
  };
}

/** Broadcast counters, recomputed from the recipient rows on every read. */
export function broadcastResponse(
  broadcast: KapsoBroadcast,
  recipients: KapsoBroadcastRecipient[],
): Record<string, unknown> {
  const count = (statuses: readonly string[]): number =>
    recipients.filter((recipient) => statuses.includes(recipient.status)).length;
  return {
    id: broadcast.broadcast_id,
    name: broadcast.name,
    status: broadcast.status,
    total_recipients: recipients.length,
    pending_count: count(["pending"]),
    // Funnel-cumulative, like real Kapso: a delivered/read/responded
    // recipient was necessarily sent first.
    sent_count: count(["sent", "delivered", "read", "responded"]),
    delivered_count: count(["delivered", "read", "responded"]),
    read_count: count(["read", "responded"]),
    responded_count: count(["responded"]),
    failed_count: count(["failed"]),
    started_at: broadcast.started_at,
    completed_at: broadcast.completed_at,
  };
}

export function broadcastRecipientRow(recipient: KapsoBroadcastRecipient): Record<string, unknown> {
  return {
    id: recipient.recipient_id,
    phone_number: recipient.phone_number,
    status: recipient.status,
    sent_at: recipient.sent_at,
    delivered_at: recipient.delivered_at,
    read_at: recipient.read_at,
    responded_at: recipient.responded_at,
    error_message: recipient.error_message,
  };
}
