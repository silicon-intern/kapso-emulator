import { createHmac } from "node:crypto";
import { type Context, debug, type Store } from "@emulators/core";
import type {
  KapsoBroadcast,
  KapsoConversation,
  KapsoEmulatorSettings,
  KapsoMessage,
  KapsoPhoneNumber,
  KapsoTemplate,
  MediaMessageType,
} from "./entities.js";
import { MEDIA_MESSAGE_TYPES } from "./entities.js";
import { kapsoConversationId, kapsoWamid } from "./ids.js";
import { getKapsoStore, getSettings, type KapsoStore, nextEventSeq } from "./store.js";

export function digitsOnly(phone: string): string {
  return phone.replace(/\D/g, "");
}

/**
 * Kapso clients authenticate with an X-API-Key header. When the seed pins a
 * key the header must match it; otherwise any non-empty key passes, matching
 * the local posture where the consuming API carries a placeholder key.
 */
export function requireApiKey(c: Context, settings: KapsoEmulatorSettings): Response | null {
  const key = c.req.header("X-API-Key")?.trim();
  if (!key) {
    return c.json({ error: { message: "Missing X-API-Key header" } }, 401);
  }
  if (settings.api_key && key !== settings.api_key) {
    return c.json({ error: { message: "Invalid X-API-Key" } }, 401);
  }
  return null;
}

/** Hex HMAC-SHA256 over the raw body, the X-Webhook-Signature scheme. */
export function signWebhookBody(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function recordEvent(
  store: Store,
  kind: string,
  phoneNumberId: string,
  customerPhone: string | null,
  data: Record<string, unknown>,
): void {
  const ks = getKapsoStore(store);
  ks.events.insert({
    seq: nextEventSeq(store),
    kind,
    phone_number_id: phoneNumberId,
    customer_phone: customerPhone,
    data,
  });
}

export function ensureConversation(
  store: Store,
  phoneNumberId: string,
  customerPhone: string,
  contactName?: string | null,
): KapsoConversation {
  const ks = getKapsoStore(store);
  const key = `${phoneNumberId}:${digitsOnly(customerPhone)}`;
  const existing = ks.conversations
    .findBy("conversation_key", key)
    .find((conversation) => conversation.active);
  if (existing) {
    if (contactName && existing.contact_name !== contactName) {
      return ks.conversations.update(existing.id, { contact_name: contactName }) ?? existing;
    }
    return existing;
  }
  return ks.conversations.insert({
    conversation_key: key,
    kapso_conversation_id: kapsoConversationId(),
    phone_number_id: phoneNumberId,
    customer_phone: digitsOnly(customerPhone),
    contact_name: contactName ?? null,
    active: true,
  });
}

/** Retire the active transport id and mint a fresh one, like a Kapso session rotation. */
export function rotateConversation(
  store: Store,
  phoneNumberId: string,
  customerPhone: string,
): KapsoConversation {
  const ks = getKapsoStore(store);
  const key = `${phoneNumberId}:${digitsOnly(customerPhone)}`;
  for (const conversation of ks.conversations.findBy("conversation_key", key)) {
    if (conversation.active) ks.conversations.update(conversation.id, { active: false });
  }
  return ensureConversation(store, phoneNumberId, customerPhone);
}

/**
 * Register the number on first lookup and keep it thereafter. A phone number
 * is CONFIGURATION in this emulator — the consuming app is pointed at an id it
 * already holds, and there is no provisioning surface here that could have
 * minted it — so refusing an id the emulator has not seen would 404 every
 * correctly configured caller. The derived WABA id is what makes the pairing
 * usable: a consumer that resolves its WABA through this route then creates
 * and reads templates under the same id.
 */
export function ensurePhoneNumber(store: Store, phoneNumberId: string): KapsoPhoneNumber {
  const ks = getKapsoStore(store);
  const existing = ks.phoneNumbers.findOneBy("phone_number_id", phoneNumberId);
  if (existing) return existing;
  return ks.phoneNumbers.insert({
    phone_number_id: phoneNumberId,
    // Ids are frequently the display digits themselves; anything else falls
    // back to Meta's own reserved test number rather than inventing a real one.
    display_phone_number: digitsOnly(phoneNumberId) || "15550000000",
    verified_name: `Emulated business ${phoneNumberId}`,
    waba_id: `waba-${phoneNumberId}`,
    status: "CONNECTED",
  });
}

function mediaKindOf(message: KapsoMessage): MediaMessageType | null {
  return (MEDIA_MESSAGE_TYPES as readonly string[]).includes(message.message_type)
    ? (message.message_type as MediaMessageType)
    : null;
}

export function mediaDownloadUrl(baseUrl: string, mediaId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/media-files/${mediaId}`;
}

/**
 * Build the `whatsapp.message.{received,sent}` webhook body a consuming app
 * parses. Outbound echoes are stamped origin `cloud_api` — consumers
 * typically treat any origin other than `business_app` as their own API
 * send — overridable via `opts.origin` (the business-app takeover
 * simulation).
 */
export function buildMessageWebhookPayload(
  message: KapsoMessage,
  conversation: KapsoConversation,
  settings: KapsoEmulatorSettings,
  opts: { origin?: string; referral?: Record<string, unknown> } = {},
): Record<string, unknown> {
  const mediaKind = mediaKindOf(message);
  const mediaUrl = message.media_id ? mediaDownloadUrl(settings.base_url, message.media_id) : null;
  const mediaObject =
    mediaKind && message.media_id
      ? {
          [mediaKind]: {
            id: message.media_id,
            ...(message.media_content_type ? { mime_type: message.media_content_type } : {}),
            ...(message.media_filename ? { filename: message.media_filename } : {}),
            ...(message.caption ? { caption: message.caption } : {}),
          },
        }
      : {};
  return {
    message: {
      id: message.wamid,
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: message.message_type,
      ...mediaObject,
      // Meta CTWA referral — present on the first inbound of an ad-click
      // conversation, exactly where real Kapso places it.
      ...(opts.referral ? { referral: opts.referral } : {}),
      kapso: {
        direction: message.direction,
        ...(opts.origin
          ? { origin: opts.origin }
          : message.direction === "outbound"
            ? { origin: "cloud_api" }
            : {}),
        whatsapp_conversation_id: conversation.kapso_conversation_id,
        content: message.content ?? "",
        ...(conversation.contact_name ? { contact_name: conversation.contact_name } : {}),
        ...(mediaUrl
          ? {
              media_url: mediaUrl,
              media_data: {
                url: mediaUrl,
                ...(message.media_filename ? { filename: message.media_filename } : {}),
                ...(message.media_content_type ? { content_type: message.media_content_type } : {}),
              },
            }
          : {}),
      },
    },
    conversation: {
      id: conversation.kapso_conversation_id,
      phone_number: conversation.customer_phone,
      phone_number_id: conversation.phone_number_id,
      ...(conversation.contact_name ? { contact_name: conversation.contact_name } : {}),
    },
    phone_number_id: conversation.phone_number_id,
  };
}

export interface WebhookDeliveryResult {
  attempted: boolean;
  status_code: number | null;
  success: boolean;
  error: string | null;
}

export async function deliverKapsoWebhook(
  store: Store,
  event: string,
  payload: Record<string, unknown>,
  wamid: string | null,
): Promise<WebhookDeliveryResult> {
  const ks = getKapsoStore(store);
  const settings = getSettings(store);
  if (!settings.webhook_url || !settings.webhook_secret) {
    debug("kapso", "webhook target not configured; dropping", { event, wamid });
    ks.webhookDeliveries.insert({
      event,
      url: settings.webhook_url ?? "(unset)",
      wamid,
      status_code: null,
      success: false,
      error: "webhook target not configured",
    });
    return { attempted: false, status_code: null, success: false, error: "not_configured" };
  }
  const rawBody = JSON.stringify(payload);
  let statusCode: number | null = null;
  let success = false;
  let error: string | null = null;
  try {
    const response = await fetch(settings.webhook_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Event": event,
        "X-Webhook-Signature": signWebhookBody(settings.webhook_secret, rawBody),
      },
      body: rawBody,
      signal: AbortSignal.timeout(10_000),
    });
    statusCode = response.status;
    success = response.ok;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  ks.webhookDeliveries.insert({
    event,
    url: settings.webhook_url,
    wamid,
    status_code: statusCode,
    success,
    error,
  });
  if (!success) {
    console.warn(`[kapso-emulator] webhook ${event} delivery failed`, {
      url: settings.webhook_url,
      status: statusCode,
      error,
    });
  }
  return { attempted: true, status_code: statusCode, success, error };
}

/**
 * Echo an accepted outbound send back as a signed whatsapp.message.sent
 * webhook after the configured delay, like Kapso's own echo. The transcript
 * row the API persists from this echo is what makes local conversations look
 * exactly like production ones.
 */
export function scheduleSentEcho(
  store: Store,
  ksMessage: KapsoMessage,
  conversation: KapsoConversation,
): void {
  const settings = getSettings(store);
  const payload = buildMessageWebhookPayload(ksMessage, conversation, settings);
  const send = () => {
    void deliverKapsoWebhook(store, "whatsapp.message.sent", payload, ksMessage.wamid).then(
      (delivery) => {
        recordEvent(store, "sent_echo", ksMessage.phone_number_id, ksMessage.customer_phone, {
          wamid: ksMessage.wamid,
          delivered: delivery.success,
        });
      },
    );
  };
  if (settings.echo_delay_ms <= 0) {
    send();
    return;
  }
  const timer = setTimeout(send, settings.echo_delay_ms);
  if (typeof timer.unref === "function") timer.unref();
}

export function notImplemented(c: Context, surface: string): Response {
  console.warn(`[kapso-emulator] 501 unimplemented ${surface}: ${c.req.method} ${c.req.path}`);
  return c.json(
    {
      error: "not_implemented",
      surface,
      method: c.req.method,
      path: c.req.path,
      hint: "This Kapso surface is not emulated yet. Add the route to kapso-emulator or keep the call out of emulator runs.",
    },
    501,
  );
}

export type { KapsoStore };

/** The `[plantilla: <name>]` marker Kapso normalizes template content to. */
export function templateMarker(name: string): string {
  return `[plantilla: ${name}]`;
}

function componentText(components: Array<Record<string, unknown>>, type: string): string | null {
  const component = components.find(
    (entry) => typeof entry.type === "string" && entry.type.toUpperCase() === type,
  );
  const text = component?.text;
  return typeof text === "string" && text.trim() ? text : null;
}

/**
 * Substitute positional `{{n}}` parameters into a registered template's BODY
 * and append its FOOTER — the rendered text real Kapso returns from the
 * Platform listing (and what template rehydration prefers over the marker).
 * Named-parameter templates without positional slots render their body as
 * stored; a template with no BODY renders null.
 */
export function renderTemplateContent(
  template: KapsoTemplate,
  bodyParams: readonly string[],
): string | null {
  const body = componentText(template.components, "BODY");
  if (!body) return null;
  const substituted = body.replace(/\{\{(\d+)\}\}/g, (match, index: string) => {
    const value = bodyParams[Number(index) - 1];
    return typeof value === "string" ? value : match;
  });
  const footer = componentText(template.components, "FOOTER");
  return footer ? `${substituted}\n\n${footer}` : substituted;
}

/** Latest registered template by name (any WABA — local runs are one tenant). */
export function findTemplateByName(store: Store, name: string): KapsoTemplate | undefined {
  const ks = getKapsoStore(store);
  const matches = ks.templates.findBy("name", name);
  return matches.sort((a, b) => b.id - a.id)[0];
}

/** Positional BODY parameter texts from a components array (send or recipient shape). */
export function bodyParamsOf(components: Array<Record<string, unknown>> | null): string[] {
  const body = (components ?? []).find(
    (entry) => typeof entry.type === "string" && entry.type.toLowerCase() === "body",
  );
  const parameters = (body?.parameters ?? []) as Array<{ type?: string; text?: string }>;
  return parameters
    .map((parameter) => (typeof parameter.text === "string" ? parameter.text : null))
    .filter((text): text is string => text !== null);
}

/**
 * Fan a broadcast out: one outbound template message per pending recipient,
 * each echoing back as a signed whatsapp.message.sent whose content is the
 * RENDERED template text — the shape a real Kapso broadcast leaves in a
 * tenant's webhook stream. Ordinary template sends through the messages
 * route keep the `[plantilla: <name>]` marker, matching real Kapso's split.
 * Recipients advance straight to sent + delivered (the emulator has no real
 * carrier to wait on); `read` and `responded` advance when the simulated
 * customer replies. Recipients in `failures.phones` fail instead: status
 * `failed` with the error message, no send, no echo. Returns the number of
 * messages fanned out.
 */
export function fanOutBroadcast(
  store: Store,
  broadcast: KapsoBroadcast,
  template: KapsoTemplate,
  failures: { phones: Set<string>; error_message: string } | null = null,
): number {
  const ks = getKapsoStore(store);
  const now = new Date().toISOString();
  const recipients = ks.broadcastRecipients
    .findBy("broadcast_id", broadcast.broadcast_id)
    .filter((recipient) => recipient.status === "pending");
  let fanned = 0;
  for (const recipient of recipients) {
    if (failures?.phones.has(recipient.phone_number)) {
      ks.broadcastRecipients.update(recipient.id, {
        status: "failed",
        error_message: failures.error_message,
      });
      recordEvent(
        store,
        "broadcast_send_failed",
        broadcast.phone_number_id,
        recipient.phone_number,
        {
          broadcast_id: broadcast.broadcast_id,
          error_message: failures.error_message,
        },
      );
      continue;
    }
    const conversation = ensureConversation(
      store,
      broadcast.phone_number_id,
      recipient.phone_number,
    );
    const params = bodyParamsOf(recipient.components);
    const rendered = renderTemplateContent(template, params);
    const message: KapsoMessage = ks.messages.insert({
      wamid: kapsoWamid(),
      phone_number_id: broadcast.phone_number_id,
      customer_phone: conversation.customer_phone,
      kapso_conversation_id: conversation.kapso_conversation_id,
      direction: "outbound",
      message_type: "template",
      content: rendered ?? templateMarker(template.name),
      rendered_content: rendered,
      template_name: template.name,
      template_params: params,
      media_id: null,
      media_content_type: null,
      media_filename: null,
      caption: null,
      payload: { broadcast_id: broadcast.broadcast_id, recipient_id: recipient.recipient_id },
    });
    ks.broadcastRecipients.update(recipient.id, {
      status: "delivered",
      sent_at: now,
      delivered_at: now,
    });
    recordEvent(store, "broadcast_send", broadcast.phone_number_id, recipient.phone_number, {
      broadcast_id: broadcast.broadcast_id,
      wamid: message.wamid,
      template_name: template.name,
    });
    scheduleSentEcho(store, message, conversation);
    fanned += 1;
  }
  return fanned;
}

/**
 * A simulated customer wrote in: any broadcast recipient row for that phone
 * that already received its blast advances to `responded` (read implied), so
 * the funnel the consuming API polls looks like a real campaign.
 */
export function advanceBroadcastRecipientsOnInbound(
  store: Store,
  phoneNumberId: string,
  customerPhone: string,
): void {
  const ks = getKapsoStore(store);
  const phone = digitsOnly(customerPhone);
  const now = new Date().toISOString();
  for (const recipient of ks.broadcastRecipients.findBy("phone_number", phone)) {
    if (
      recipient.status !== "sent" &&
      recipient.status !== "delivered" &&
      recipient.status !== "read"
    ) {
      continue;
    }
    const broadcast = ks.broadcasts.findOneBy("broadcast_id", recipient.broadcast_id);
    if (!broadcast || broadcast.phone_number_id !== phoneNumberId) continue;
    ks.broadcastRecipients.update(recipient.id, {
      status: "responded",
      read_at: recipient.read_at ?? now,
      responded_at: now,
    });
  }
}
