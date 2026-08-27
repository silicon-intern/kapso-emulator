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
import { getKapsoStore, getSettings, setSettings } from "./../store.js";

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

const INBOUND_TYPES = new Set(["text", "interactive", "image", "audio", "video", "document"]);

/**
 * The inject surface a chat UI (or a test) drives: build a schema-correct
 * Kapso inbound payload, sign it, and POST it to the configured webhook —
 * exactly what real Kapso does when a customer writes on WhatsApp.
 */
export function simulatorRoutes({ app, store }: RouteContext): void {
  app.post("/_kapso/simulate/inbound-message", async (c) => {
    const body = (await c.req.json().catch(() => null)) as InboundBody | null;
    if (!body) return c.json({ error: { message: "Invalid JSON body" } }, 400);
    const phoneNumberId = body.phone_number_id?.trim();
    const from = body.from?.trim();
    if (!phoneNumberId || !from) {
      return c.json({ error: { message: "phone_number_id and from are required" } }, 400);
    }
    const type = body.type ?? (body.media ? mediaTypeFor(body.media.content_type) : "text");
    if (!type || !INBOUND_TYPES.has(type)) {
      return c.json({ error: { message: `Unsupported inbound type "${body.type ?? ""}"` } }, 400);
    }
    const text = body.text ?? "";
    if (type === "text" && !text.trim()) {
      return c.json({ error: { message: "text is required for a text message" } }, 400);
    }

    const ks = getKapsoStore(store);
    const conversation = ensureConversation(store, phoneNumberId, from, body.contact_name ?? null);

    let mediaId: string | null = null;
    let mediaContentType: string | null = null;
    let mediaFilename: string | null = null;
    if (body.media?.data_base64 && body.media.content_type) {
      const bytes = Buffer.from(body.media.data_base64, "base64");
      const asset = ks.media.insert({
        media_id: kapsoMediaId(),
        content_type: body.media.content_type,
        file_name: body.media.filename ?? null,
        data_base64: body.media.data_base64,
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
      content: text || (body.media?.caption ?? null),
      rendered_content: null,
      template_name: null,
      template_params: null,
      media_id: mediaId,
      media_content_type: mediaContentType,
      media_filename: mediaFilename,
      caption: body.media?.caption ?? null,
      payload: body,
    });
    advanceBroadcastRecipientsOnInbound(store, phoneNumberId, message.customer_phone);
    const payload = buildMessageWebhookPayload(message, conversation, getSettings(store), {
      referral: body.referral,
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
    const phoneNumberId = body.phone_number_id?.trim();
    const from = body.from?.trim();
    const text = body.text?.trim();
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
    const phoneNumberId = body?.phone_number_id?.trim();
    const from = body?.from?.trim();
    if (!phoneNumberId || !from) {
      return c.json({ error: { message: "phone_number_id and from are required" } }, 400);
    }
    const conversation = rotateConversation(store, phoneNumberId, from);
    recordEvent(store, "conversation_rotated", phoneNumberId, digitsOnly(from), {
      kapso_conversation_id: conversation.kapso_conversation_id,
    });
    return c.json({ kapso_conversation_id: conversation.kapso_conversation_id });
  });

  // Wipe conversations/messages/media/events but keep the wiring (webhook
  // target, secret, delays) so the stack stays usable after a reset.
  app.post("/_kapso/simulate/reset", (c) => {
    const settings = getSettings(store);
    store.reset();
    setSettings(store, settings);
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
    if (body.template_review && body.template_review.status !== "REJECTED") {
      return c.json({ error: { message: 'template_review.status must be "REJECTED"' } }, 400);
    }
    if (body.broadcast && !Array.isArray(body.broadcast.phones)) {
      return c.json(
        { error: { message: "broadcast.phones must be an array of phone strings" } },
        400,
      );
    }
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
    const events = ks.events
      .all()
      .filter((event) => event.seq > (Number.isFinite(after) ? after : 0))
      .sort((a, b) => a.seq - b.seq)
      .slice(0, 500);
    const lastSeq = events.length > 0 ? events[events.length - 1].seq : after;
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

function mediaTypeFor(contentType: string | undefined): string | null {
  if (!contentType) return null;
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("video/")) return "video";
  return "document";
}
