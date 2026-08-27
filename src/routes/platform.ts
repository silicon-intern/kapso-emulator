import type { RouteContext } from "@emulators/core";
import type { KapsoBroadcastRecipient } from "./../entities.js";
import { broadcastFailures } from "./../failures.js";
import {
  broadcastRecipientRow,
  broadcastResponse,
  platformMessageRow,
  platformPhoneNumberRow,
} from "./../formatters.js";
import {
  digitsOnly,
  ensurePhoneNumber,
  fanOutBroadcast,
  notImplemented,
  recordEvent,
  requireApiKey,
} from "./../helpers.js";
import { kapsoBroadcastId, kapsoBroadcastRecipientId } from "./../ids.js";
import { getKapsoStore, getSettings } from "./../store.js";

/** Kapso caps recipient pages server-side BELOW the common client request of
 *  100, so a local run with a real-sized audience exercises the same
 *  multi-page path production does; `meta.total_pages` is the stop authority. */
const RECIPIENTS_PAGE_CAP = 50;

/**
 * Kapso Platform API subset (the app.kapso.ai surface, X-API-Key auth). Only
 * what the message flow touches is emulated; everything else 501s loudly via
 * the fallback below.
 */
export function platformRoutes({ app, store }: RouteContext): void {
  // One connected number. Consumers read `whatsapp_business_account_id` off it
  // to discover which WABA to submit and poll templates under, so a 501 here
  // turns every template CREATE from a number-only caller into a 500.
  app.get("/platform/v1/whatsapp/phone_numbers/:phoneNumberId", (c) => {
    const settings = getSettings(store);
    const denied = requireApiKey(c, settings);
    if (denied) return denied;
    const phoneNumber = ensurePhoneNumber(store, c.req.param("phoneNumberId"));
    return c.json({ data: platformPhoneNumberRow(phoneNumber) });
  });

  // Conversation message listing — what template rehydration reads
  // (fetchKapsoOutboundTemplateMessage matches rows by wamid and pulls
  // kapso.message_type_data for the template name + body params).
  app.get("/platform/v1/whatsapp/messages", (c) => {
    const settings = getSettings(store);
    const denied = requireApiKey(c, settings);
    if (denied) return denied;
    const conversationId = c.req.query("conversation_id");
    if (!conversationId) {
      return c.json({ error: { message: "conversation_id is required" } }, 400);
    }
    const phoneNumberId = c.req.query("phone_number_id");
    const direction = c.req.query("direction");
    const limitRaw = Number(c.req.query("limit") ?? 20);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 100) : 20;
    const ks = getKapsoStore(store);
    const rows = ks.messages
      .findBy("kapso_conversation_id", conversationId)
      .filter((message) => !phoneNumberId || message.phone_number_id === phoneNumberId)
      .filter((message) => !direction || message.direction === direction)
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
      .map(platformMessageRow);
    return c.json({ data: rows });
  });

  // Broadcasts: the send primitive behind template campaigns. Create with a
  // registered template, attach recipients while draft, send, poll counters +
  // per-recipient statuses. The send fans out one real outbound template
  // message per recipient, so echoes, transcripts, and rehydration behave
  // exactly like a production blast.
  app.post("/platform/v1/whatsapp/broadcasts", async (c) => {
    const settings = getSettings(store);
    const denied = requireApiKey(c, settings);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => null)) as {
      whatsapp_broadcast?: {
        name?: string;
        phone_number_id?: string;
        whatsapp_template_id?: string;
      };
    } | null;
    const input = body?.whatsapp_broadcast;
    if (!input?.name?.trim() || !input.phone_number_id?.trim() || !input.whatsapp_template_id) {
      return c.json(
        { error: { message: "name, phone_number_id and whatsapp_template_id are required" } },
        400,
      );
    }
    const ks = getKapsoStore(store);
    const template = ks.templates.findOneBy("template_id", input.whatsapp_template_id);
    if (!template) {
      // Loud, like the 501 rule: a stale seeded template id must surface as
      // an error the consuming dispatch reports, never as a silent fake send.
      return c.json(
        {
          error: {
            message: `Unknown whatsapp_template_id "${input.whatsapp_template_id}" — create the template through the Meta proxy first`,
          },
        },
        404,
      );
    }
    const broadcast = ks.broadcasts.insert({
      broadcast_id: kapsoBroadcastId(),
      name: input.name.trim(),
      phone_number_id: input.phone_number_id.trim(),
      whatsapp_template_id: input.whatsapp_template_id,
      status: "draft",
      started_at: null,
      completed_at: null,
    });
    recordEvent(store, "broadcast_created", broadcast.phone_number_id, null, {
      broadcast_id: broadcast.broadcast_id,
      template_name: template.name,
    });
    return c.json({ data: broadcastResponse(broadcast, []) });
  });

  app.post("/platform/v1/whatsapp/broadcasts/:broadcastId/recipients", async (c) => {
    const settings = getSettings(store);
    const denied = requireApiKey(c, settings);
    if (denied) return denied;
    const ks = getKapsoStore(store);
    const broadcast = ks.broadcasts.findOneBy("broadcast_id", c.req.param("broadcastId"));
    if (!broadcast) return c.json({ error: { message: "Broadcast not found" } }, 404);
    if (broadcast.status !== "draft") {
      return c.json({ error: { message: "Recipients can only be added while draft" } }, 422);
    }
    const body = (await c.req.json().catch(() => null)) as {
      whatsapp_broadcast?: {
        recipients?: Array<{
          phone_number?: string;
          components?: Array<Record<string, unknown>>;
        }>;
      };
    } | null;
    const recipients = body?.whatsapp_broadcast?.recipients;
    if (!Array.isArray(recipients)) {
      return c.json({ error: { message: "whatsapp_broadcast.recipients is required" } }, 400);
    }
    const existing = new Set(
      ks.broadcastRecipients
        .findBy("broadcast_id", broadcast.broadcast_id)
        .map((recipient) => recipient.phone_number),
    );
    let added = 0;
    let duplicates = 0;
    const errors: string[] = [];
    for (const entry of recipients) {
      const phone = digitsOnly(entry.phone_number ?? "");
      if (!phone) {
        errors.push(`invalid phone_number "${entry.phone_number ?? ""}"`);
        continue;
      }
      if (existing.has(phone)) {
        duplicates += 1;
        continue;
      }
      existing.add(phone);
      ks.broadcastRecipients.insert({
        recipient_id: kapsoBroadcastRecipientId(),
        broadcast_id: broadcast.broadcast_id,
        phone_number: phone,
        status: "pending",
        components: entry.components ?? null,
        sent_at: null,
        delivered_at: null,
        read_at: null,
        responded_at: null,
        error_message: null,
      });
      added += 1;
    }
    return c.json({ data: { added, duplicates, errors } });
  });

  app.post("/platform/v1/whatsapp/broadcasts/:broadcastId/send", (c) => {
    const settings = getSettings(store);
    const denied = requireApiKey(c, settings);
    if (denied) return denied;
    const ks = getKapsoStore(store);
    const broadcast = ks.broadcasts.findOneBy("broadcast_id", c.req.param("broadcastId"));
    if (!broadcast) return c.json({ error: { message: "Broadcast not found" } }, 404);
    if (broadcast.status !== "draft") {
      return c.json({ error: { message: `Broadcast is ${broadcast.status}, not draft` } }, 422);
    }
    const template = ks.templates.findOneBy("template_id", broadcast.whatsapp_template_id);
    if (!template) {
      return c.json({ error: { message: "Broadcast template no longer exists" } }, 422);
    }
    const startedAt = new Date().toISOString();
    ks.broadcasts.update(broadcast.id, { status: "sending", started_at: startedAt });
    const fanned = fanOutBroadcast(
      store,
      { ...broadcast, status: "sending", started_at: startedAt },
      template,
      broadcastFailures(store),
    );
    const completed =
      ks.broadcasts.update(broadcast.id, {
        status: "completed",
        completed_at: new Date().toISOString(),
      }) ?? broadcast;
    recordEvent(store, "broadcast_sent", broadcast.phone_number_id, null, {
      broadcast_id: broadcast.broadcast_id,
      recipients: fanned,
    });
    return c.json({
      data: broadcastResponse(
        completed,
        ks.broadcastRecipients.findBy("broadcast_id", broadcast.broadcast_id),
      ),
    });
  });

  app.get("/platform/v1/whatsapp/broadcasts/:broadcastId", (c) => {
    const settings = getSettings(store);
    const denied = requireApiKey(c, settings);
    if (denied) return denied;
    const ks = getKapsoStore(store);
    const broadcast = ks.broadcasts.findOneBy("broadcast_id", c.req.param("broadcastId"));
    if (!broadcast) return c.json({ error: { message: "Broadcast not found" } }, 404);
    return c.json({
      data: broadcastResponse(
        broadcast,
        ks.broadcastRecipients.findBy("broadcast_id", broadcast.broadcast_id),
      ),
    });
  });

  app.get("/platform/v1/whatsapp/broadcasts/:broadcastId/recipients", (c) => {
    const settings = getSettings(store);
    const denied = requireApiKey(c, settings);
    if (denied) return denied;
    const ks = getKapsoStore(store);
    const broadcast = ks.broadcasts.findOneBy("broadcast_id", c.req.param("broadcastId"));
    if (!broadcast) return c.json({ error: { message: "Broadcast not found" } }, 404);
    const pageRaw = Number(c.req.query("page") ?? 1);
    const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
    const perPageRaw = Number(c.req.query("per_page") ?? RECIPIENTS_PAGE_CAP);
    const perPage = Number.isFinite(perPageRaw)
      ? Math.min(Math.max(1, Math.trunc(perPageRaw)), RECIPIENTS_PAGE_CAP)
      : RECIPIENTS_PAGE_CAP;
    const all: KapsoBroadcastRecipient[] = ks.broadcastRecipients
      .findBy("broadcast_id", broadcast.broadcast_id)
      .sort((a, b) => a.id - b.id);
    const rows = all.slice((page - 1) * perPage, page * perPage).map(broadcastRecipientRow);
    return c.json({
      data: rows,
      meta: {
        page,
        per_page: perPage,
        total_pages: Math.max(1, Math.ceil(all.length / perPage)),
        total_count: all.length,
      },
    });
  });
}

/** Catch-all for the rest of the Platform API: loud 501, registered last. */
export function platformFallbackRoutes({ app }: RouteContext): void {
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    app.on(method, "/platform/:rest{.*}", (c) => notImplemented(c, "kapso platform"));
  }
}
