import type { RouteContext } from "@emulators/core";
import type { KapsoMessage } from "./../entities.js";
import {
  clearFailureRules,
  type FailureRules,
  getFailureRules,
  setFailureRules,
} from "./../failures.js";
import {
  advanceBroadcastRecipientsOnInbound,
  buildMessageWebhookPayload,
  deliverKapsoWebhook,
  digitsOnly,
  ensureConversation,
  recordEvent,
  rotateConversation,
} from "./../helpers.js";
import { kapsoMediaId, kapsoWamid } from "./../ids.js";
import { currentEventSeq, getKapsoStore, getSettings, resetKapsoState } from "./../store.js";

/** JSON bodies routinely carry numbers where strings belong; never crash on them. */
function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

interface InboundBody {
  phone_number_id?: string;
  from?: string;
  type?: string;
  text?: string;
  contact_name?: string;
  media?: {
    content_type?: string;
    data_base64?: string;
    filename?: string;
    caption?: string;
  };
  /** Meta CTWA referral passthrough (source_type/source_id/headline/body/
   *  ctwa_clid/…) — rides the webhook as `message.referral`, exactly where
   *  real Kapso puts it, so a consumer's ad-attribution capture is
   *  exercisable locally. */
  referral?: Record<string, unknown>;
}

const INBOUND_TYPES = new Set([
  "text",
  "interactive",
  "image",
  "audio",
  "video",
  "document",
  "sticker",
]);

/**
 * The inject surface a chat UI (or a test) drives: build a schema-correct
 * Kapso inbound payload, sign it, and POST it to the configured webhook —
 * exactly what real Kapso does when a customer writes on WhatsApp.
 */
export function simulatorRoutes({ app, store }: RouteContext): void {
  app.post("/_kapso/simulate/inbound-message", async (c) => {
    const body = (await c.req.json().catch(() => null)) as InboundBody | null;
    if (!body) return c.json({ error: { message: "Invalid JSON body" } }, 400);
    const phoneNumberId = str(body.phone_number_id)?.trim();
    const from = str(body.from)?.trim();
    if (!phoneNumberId || !from) {
      return c.json({ error: { message: "phone_number_id and from are required" } }, 400);
    }
    const media = body.media && typeof body.media === "object" ? body.media : undefined;
    if (media && (!str(media.data_base64) || !str(media.content_type))) {
      return c.json(
        { error: { message: "media requires both content_type and data_base64" } },
        400,
      );
    }
    const type = str(body.type) ?? (media ? mediaTypeFor(str(media.content_type)) : "text");
    if (!type || !INBOUND_TYPES.has(type)) {
      return c.json(
        { error: { message: `Unsupported inbound type "${str(body.type) ?? ""}"` } },
        400,
      );
    }
    const text = str(body.text) ?? "";
    if (type === "text" && !text.trim()) {
      return c.json({ error: { message: "text is required for a text message" } }, 400);
    }

    const ks = getKapsoStore(store);
    const conversation = ensureConversation(
      store,
      phoneNumberId,
      from,
      str(body.contact_name) ?? null,
    );

    let mediaId: string | null = null;
    let mediaContentType: string | null = null;
    let mediaFilename: string | null = null;
    if (media?.data_base64 && media.content_type) {
      const bytes = Buffer.from(media.data_base64, "base64");
      const asset = ks.media.insert({
        media_id: kapsoMediaId(),
        content_type: media.content_type,
        file_name: str(media.filename) ?? null,
        data_base64: media.data_base64,
        byte_size: bytes.byteLength,
      });
      mediaId = asset.media_id;
      mediaContentType = asset.content_type;
      mediaFilename = asset.file_name;
    }

    const message: KapsoMessage = ks.messages.insert({
      wamid: kapsoWamid(),
      phone_number_id: phoneNumberId,
      customer_phone: digitsOnly(from),
      kapso_conversation_id: conversation.kapso_conversation_id,
      direction: "inbound",
      message_type: type,
      content: text || (str(media?.caption) ?? null),
      rendered_content: null,
      template_name: null,
      template_params: null,
      media_id: mediaId,
      media_content_type: mediaContentType,
      media_filename: mediaFilename,
      caption: str(media?.caption) ?? null,
      payload: body,
    });
    advanceBroadcastRecipientsOnInbound(store, phoneNumberId, message.customer_phone);
    const payload = buildMessageWebhookPayload(message, conversation, getSettings(store), {
      referral:
        body.referral && typeof body.referral === "object" && !Array.isArray(body.referral)
          ? body.referral
          : undefined,
    });
    const delivery = await deliverKapsoWebhook(
      store,
      "whatsapp.message.received",
      payload,
      message.wamid,
    );
    recordEvent(store, "inbound_message", phoneNumberId, message.customer_phone, {
      wamid: message.wamid,
      type,
      content: message.content,
      delivered: delivery.success,
    });
    return c.json({
      wamid: message.wamid,
      kapso_conversation_id: conversation.kapso_conversation_id,
      delivery,
    });
  });

  // Business App reply: what real Kapso emits when the OWNER answers from
  // their phone's WhatsApp Business App. Consuming APIs typically read the
  // `business_app` origin as a human takeover, so this is how a simulator
  // exercises handoff/takeover flows.
  app.post("/_kapso/simulate/business-app-message", async (c) => {
    const body = (await c.req.json().catch(() => null)) as InboundBody | null;
    if (!body) return c.json({ error: { message: "Invalid JSON body" } }, 400);
    const phoneNumberId = str(body.phone_number_id)?.trim();
    const from = str(body.from)?.trim();
    const text = str(body.text)?.trim();
    if (!phoneNumberId || !from || !text) {
      return c.json({ error: { message: "phone_number_id, from and text are required" } }, 400);
    }
    const ks = getKapsoStore(store);
    const conversation = ensureConversation(store, phoneNumberId, from);
    const message: KapsoMessage = ks.messages.insert({
      wamid: kapsoWamid(),
      phone_number_id: phoneNumberId,
      customer_phone: digitsOnly(from),
      kapso_conversation_id: conversation.kapso_conversation_id,
      direction: "outbound",
      message_type: "text",
      content: text,
      rendered_content: null,
      template_name: null,
      template_params: null,
      media_id: null,
      media_content_type: null,
      media_filename: null,
      caption: null,
      payload: body,
    });
    const payload = buildMessageWebhookPayload(message, conversation, getSettings(store), {
      origin: "business_app",
    });
    const delivery = await deliverKapsoWebhook(
      store,
      "whatsapp.message.sent",
      payload,
      message.wamid,
    );
    recordEvent(store, "business_app_message", phoneNumberId, message.customer_phone, {
      wamid: message.wamid,
      content: text,
      delivered: delivery.success,
    });
    return c.json({
      wamid: message.wamid,
      kapso_conversation_id: conversation.kapso_conversation_id,
      delivery,
    });
  });

  app.post("/_kapso/simulate/rotate-conversation", async (c) => {
    const body = (await c.req.json().catch(() => null)) as InboundBody | null;
    const phoneNumberId = str(body?.phone_number_id)?.trim();
    const from = str(body?.from)?.trim();
    if (!phoneNumberId || !from) {
      return c.json({ error: { message: "phone_number_id and from are required" } }, 400);
    }
    const conversation = rotateConversation(store, phoneNumberId, from);
    recordEvent(store, "conversation_rotated", phoneNumberId, digitsOnly(from), {
      kapso_conversation_id: conversation.kapso_conversation_id,
    });
    return c.json({ kapso_conversation_id: conversation.kapso_conversation_id });
  });

  // Wipe conversations/messages/media/events (and failure rules) but keep
  // the wiring (webhook target, secret, delays) AND the event sequence, so
  // the stack stays usable and cursor-polling clients stay subscribed.
  app.post("/_kapso/simulate/reset", (c) => {
    resetKapsoState(store);
    return c.json({ ok: true });
  });

  // Failure injection: declarative rules that make the emulator refuse the
  // way real Meta/Kapso do (see failures.ts). POST replaces the whole rule
  // set, GET reads it, DELETE clears it; simulate/reset clears it too.
  app.get("/_kapso/simulate/failures", (c) => c.json(getFailureRules(store)));

  app.post("/_kapso/simulate/failures", async (c) => {
    const body = (await c.req.json().catch(() => null)) as FailureRules | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: { message: "Invalid JSON body" } }, 400);
    }
    const supported = ["send", "template_review", "broadcast"];
    const unknown = Object.keys(body).filter((key) => !supported.includes(key));
    if (unknown.length > 0) {
      return c.json(
        {
          error: {
            message: `Unknown failure rule(s): ${unknown.join(", ")}. Supported: ${supported.join(", ")}`,
          },
        },
        400,
      );
    }
    const problem = validateFailureRules(body);
    if (problem) return c.json({ error: { message: problem } }, 400);
    return c.json(setFailureRules(store, body));
  });

  app.delete("/_kapso/simulate/failures", (c) => {
    clearFailureRules(store);
    return c.json({});
  });

  // Cursor-polled ephemeral feed: typing indicators, read receipts, send log.
  app.get("/_kapso/simulate/events", (c) => {
    const after = Number(c.req.query("after") ?? 0);
    const ks = getKapsoStore(store);
    const cursor = Number.isFinite(after) ? after : 0;
    const events = ks.events
      .all()
      .filter((event) => event.seq > cursor)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, 500);
    // On an empty page, clamp the echoed cursor to the real max seq so an
    // out-of-range client cursor self-heals instead of being repeated back.
    const lastSeq =
      events.length > 0 ? events[events.length - 1].seq : Math.min(cursor, currentEventSeq(store));
    return c.json({ events, last_seq: lastSeq });
  });

  // Thread snapshot for UIs/tests that want the emulator's own view.
  app.get("/_kapso/simulate/thread", (c) => {
    const phoneNumberId = c.req.query("phone_number_id");
    const from = c.req.query("from");
    if (!phoneNumberId || !from) {
      return c.json({ error: { message: "phone_number_id and from are required" } }, 400);
    }
    const ks = getKapsoStore(store);
    const key = `${phoneNumberId}:${digitsOnly(from)}`;
    const conversation = ks.conversations.findBy("conversation_key", key).find((row) => row.active);
    const messages = ks.messages
      .findBy("customer_phone", digitsOnly(from))
      .filter((message) => message.phone_number_id === phoneNumberId)
      .sort((a, b) => a.id - b.id);
    return c.json({ conversation: conversation ?? null, messages });
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns a human-readable problem, or null when the rule set is valid. */
function validateFailureRules(body: FailureRules): string | null {
  if (body.send !== undefined) {
    if (!isPlainObject(body.send)) return "send must be an object";
    if (body.send.to !== undefined && typeof body.send.to !== "string") {
      return "send.to must be a phone string";
    }
    const times = body.send.times;
    if (
      times !== undefined &&
      (typeof times !== "number" || !Number.isInteger(times) || times < 1)
    ) {
      return "send.times must be a positive integer";
    }
    if (body.send.error !== undefined) {
      if (!isPlainObject(body.send.error)) return "send.error must be an object";
      const { code, message, http_status } = body.send.error;
      if (code !== undefined && !Number.isInteger(code))
        return "send.error.code must be an integer";
      if (message !== undefined && typeof message !== "string") {
        return "send.error.message must be a string";
      }
      if (
        http_status !== undefined &&
        (typeof http_status !== "number" ||
          !Number.isInteger(http_status) ||
          http_status < 400 ||
          http_status > 599)
      ) {
        return "send.error.http_status must be an error status between 400 and 599";
      }
    }
  }
  if (body.template_review !== undefined) {
    if (!isPlainObject(body.template_review) || body.template_review.status !== "REJECTED") {
      return 'template_review.status must be "REJECTED"';
    }
    if (
      body.template_review.reason !== undefined &&
      typeof body.template_review.reason !== "string"
    ) {
      return "template_review.reason must be a string";
    }
  }
  if (body.broadcast !== undefined) {
    if (
      !isPlainObject(body.broadcast) ||
      !Array.isArray(body.broadcast.phones) ||
      body.broadcast.phones.some((phone) => typeof phone !== "string")
    ) {
      return "broadcast.phones must be an array of phone strings";
    }
    if (
      body.broadcast.error_message !== undefined &&
      typeof body.broadcast.error_message !== "string"
    ) {
      return "broadcast.error_message must be a string";
    }
  }
  return null;
}

function mediaTypeFor(contentType: string | undefined): string | null {
  if (!contentType) return null;
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("video/")) return "video";
  return "document";
}
