import type { RouteContext } from "@emulators/core";
import type { KapsoMessage, KapsoTemplate } from "./../entities.js";
import { SUPPORTED_MESSAGE_TYPES } from "./../entities.js";
import { consumeSendFailure, templateRejection } from "./../failures.js";
import { mediaMetadataResponse, sendAcceptedResponse, templateResponse } from "./../formatters.js";
import {
  ensureConversation,
  findTemplateByName,
  notImplemented,
  recordEvent,
  renderTemplateContent,
  requireApiKey,
  scheduleSentEcho,
} from "./../helpers.js";
import { kapsoMediaId, kapsoTemplateId, kapsoWamid } from "./../ids.js";
import { getKapsoStore, getSettings } from "./../store.js";

// Meta's allowed upload MIME types, in the order its own (#100) refusal
// lists them (captured verbatim from a real Graph error response).
const META_MEDIA_UPLOAD_TYPES = [
  "audio/aac",
  "audio/mp4",
  "audio/mpeg",
  "audio/amr",
  "audio/ogg",
  "audio/opus",
  "application/vnd.ms-powerpoint",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/pdf",
  "text/plain",
  "application/vnd.ms-excel",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/3gpp",
];

interface SendBody {
  messaging_product?: string;
  status?: string;
  message_id?: string;
  typing_indicator?: { type?: string };
  to?: string;
  type?: string;
  text?: { body?: string };
  template?: {
    name?: string;
    language?: { code?: string };
    components?: Array<{
      type?: string;
      parameters?: Array<{ type?: string; text?: string }>;
    }>;
  };
  interactive?: {
    type?: string;
    body?: { text?: string };
    action?: Record<string, unknown>;
  };
  image?: MediaRef;
  audio?: MediaRef;
  video?: MediaRef;
  document?: MediaRef;
  sticker?: MediaRef;
}

interface MediaRef {
  id?: string;
  link?: string;
  caption?: string;
  filename?: string;
}

/**
 * Normalized display content for an interactive list send: body text plus the
 * rows, one per line — so the persisted transcript shows WHAT was offered,
 * not just the lead-in sentence.
 */
function interactiveContent(interactive: SendBody["interactive"]): string {
  const body = interactive?.body?.text ?? "";
  const sections = (interactive?.action?.sections ?? []) as Array<{
    rows?: Array<{ title?: string; description?: string }>;
  }>;
  const rows = sections.flatMap((section) => section.rows ?? []);
  if (rows.length === 0) return body;
  const lines = rows.map(
    (row) => `▸ ${row.title ?? ""}${row.description ? ` — ${row.description}` : ""}`,
  );
  return [body, ...lines].filter(Boolean).join("\n");
}

function templateBodyParams(template: SendBody["template"]): string[] {
  const body = (template?.components ?? []).find(
    (component) => component.type?.toLowerCase() === "body",
  );
  return (body?.parameters ?? [])
    .map((parameter) => (typeof parameter.text === "string" ? parameter.text : null))
    .filter((text): text is string => text !== null);
}

/**
 * Kapso Meta proxy: the surface `@kapso/whatsapp-cloud-api` talks to. Paths
 * mirror the Meta Graph API under `/meta/whatsapp/:version/...`, exactly how
 * the real proxy nests them under https://api.kapso.ai/meta/whatsapp.
 */
export function messageRoutes({ app, store }: RouteContext): void {
  app.post("/meta/whatsapp/:version/:phoneNumberId/messages", async (c) => {
    const settings = getSettings(store);
    const denied = requireApiKey(c, settings);
    if (denied) return denied;
    const phoneNumberId = c.req.param("phoneNumberId");
    const body = (await c.req.json().catch(() => null)) as SendBody | null;
    if (!body) return c.json({ error: { message: "Invalid JSON body" } }, 400);

    // Read receipt + typing indicator (markRead): no message is created and
    // nothing echoes back; the ephemeral state reaches the UI via events.
    if (body.status === "read") {
      recordEvent(store, "read_receipt", phoneNumberId, null, {
        message_id: body.message_id ?? null,
        typing: Boolean(body.typing_indicator),
      });
      return c.json({ success: true });
    }

    const to = body.to?.trim();
    if (!to) return c.json({ error: { message: "`to` is required" } }, 400);
    const type = body.type ?? "text";
    if (!(SUPPORTED_MESSAGE_TYPES as readonly string[]).includes(type)) {
      return notImplemented(c, `meta message type "${type}"`);
    }

    const mediaRef =
      type === "image" ||
      type === "audio" ||
      type === "video" ||
      type === "document" ||
      type === "sticker"
        ? (body[type as "image"] ?? null)
        : null;
    const content =
      type === "text"
        ? (body.text?.body ?? "")
        : type === "template"
          ? `[plantilla: ${body.template?.name ?? "unknown"}]`
          : type === "interactive"
            ? interactiveContent(body.interactive)
            : (mediaRef?.caption ?? "");

    const conversation = ensureConversation(store, phoneNumberId, to);
    const ks = getKapsoStore(store);
    const asset = mediaRef?.id ? ks.media.findOneBy("media_id", mediaRef.id) : undefined;
    // Real Meta refuses a media id it did not mint under the current app
    // authorization — handles die on re-registration, so a cached id can be
    // rejected while looking perfectly fresh. An unknown id gets the same
    // Graph rejection real Meta sends, so a consumer's cached-id recovery
    // paths are exercisable locally. Do not relax to accept-anything: that
    // masks the entire stale-handle failure class.
    if (mediaRef?.id && !asset) {
      return c.json(
        {
          error: {
            message: `Param ${type}.id is not a valid whatsapp business account media attachment ID`,
            type: "OAuthException",
            code: 100,
            fbtrace_id: "kapso-emulator",
          },
        },
        400,
      );
    }
    // An injected send failure refuses here, after payload validation, the
    // way a real delivery refusal would: no message row, no echo.
    const failure = consumeSendFailure(store, to);
    if (failure) {
      recordEvent(store, "send_failed", phoneNumberId, conversation.customer_phone, {
        type,
        code: failure.body.error.code,
      });
      return c.json(failure.body, failure.http_status as 400);
    }
    // A registered template renders its real text for the Platform listing
    // (rehydration's primary source); unknown templates keep only the marker.
    const registered =
      type === "template" && body.template?.name
        ? findTemplateByName(store, body.template.name)
        : undefined;
    const message: KapsoMessage = ks.messages.insert({
      wamid: kapsoWamid(),
      phone_number_id: phoneNumberId,
      customer_phone: conversation.customer_phone,
      kapso_conversation_id: conversation.kapso_conversation_id,
      direction: "outbound",
      message_type: type,
      content: content || null,
      rendered_content: registered
        ? renderTemplateContent(registered, templateBodyParams(body.template))
        : null,
      template_name: type === "template" ? (body.template?.name ?? null) : null,
      template_params: type === "template" ? templateBodyParams(body.template) : null,
      media_id: mediaRef?.id ?? null,
      media_content_type: asset?.content_type ?? null,
      media_filename: mediaRef?.filename ?? asset?.file_name ?? null,
      caption: mediaRef?.caption ?? null,
      payload: body,
    });
    recordEvent(store, "outbound_message", phoneNumberId, conversation.customer_phone, {
      wamid: message.wamid,
      type,
      content: message.content,
      ...(type === "interactive" ? { interactive: body.interactive ?? null } : {}),
    });
    scheduleSentEcho(store, message, conversation);
    return c.json(sendAcceptedResponse(to, message.wamid));
  });

  // Media upload: multipart form with `file` (+ messaging_product/type).
  // Meta validates the file PART's own content type — the `type` form field
  // does not override it — so the emulator enforces the same allowed list.
  // The accept-anything version hid the costliest client bug this surface
  // sees: a raw Buffer handed to an SDK serializes as a typeless part
  // (application/octet-stream), which real Meta refuses with error (#100)
  // while the emulator minted a media id anyway.
  app.post("/meta/whatsapp/:version/:phoneNumberId/media", async (c) => {
    const settings = getSettings(store);
    const denied = requireApiKey(c, settings);
    if (denied) return denied;
    const parsed = await c.req.parseBody();
    const file = parsed.file;
    if (!(file instanceof File)) {
      return c.json({ error: { message: "multipart `file` field is required" } }, 400);
    }
    const partType = (file.type || "application/octet-stream").split(";")[0].trim().toLowerCase();
    if (!META_MEDIA_UPLOAD_TYPES.includes(partType)) {
      return c.json(
        {
          error: {
            message:
              "(#100) Param file must be a file with one of the following types: " +
              `${META_MEDIA_UPLOAD_TYPES.join(", ")}. Received file of type '${partType}'.`,
            type: "OAuthException",
            code: 100,
          },
        },
        400,
      );
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    const ks = getKapsoStore(store);
    const asset = ks.media.insert({
      media_id: kapsoMediaId(),
      content_type: partType,
      file_name: file.name || null,
      data_base64: bytes.toString("base64"),
      byte_size: bytes.byteLength,
    });
    return c.json({ id: asset.media_id });
  });

  // Media metadata resolve (GET) and delete, addressed by bare media id.
  app.get("/meta/whatsapp/:version/:mediaId", (c) => {
    const settings = getSettings(store);
    const denied = requireApiKey(c, settings);
    if (denied) return denied;
    const ks = getKapsoStore(store);
    const asset = ks.media.findOneBy("media_id", c.req.param("mediaId"));
    if (!asset) return c.json({ error: { message: "Media not found" } }, 404);
    return c.json(mediaMetadataResponse(settings.base_url, asset));
  });

  app.delete("/meta/whatsapp/:version/:mediaId", (c) => {
    const settings = getSettings(store);
    const denied = requireApiKey(c, settings);
    if (denied) return denied;
    const ks = getKapsoStore(store);
    const asset = ks.media.findOneBy("media_id", c.req.param("mediaId"));
    if (!asset) return c.json({ error: { message: "Media not found" } }, 404);
    ks.media.delete(asset.id);
    return c.json({ success: true });
  });

  // WABA message templates (create/list). Review is INSTANT: real Meta
  // review takes ~24h, which a local loop must never wait on — an
  // approved-at-create template is what lets template flows run end to end.
  // The template_review failure rule flips the outcome to REJECTED.
  app.post("/meta/whatsapp/:version/:wabaId/message_templates", async (c) => {
    const settings = getSettings(store);
    const denied = requireApiKey(c, settings);
    if (denied) return denied;
    const wabaId = c.req.param("wabaId");
    const body = (await c.req.json().catch(() => null)) as {
      name?: string;
      language?: string;
      category?: string;
      components?: Array<Record<string, unknown>>;
    } | null;
    if (!body?.name?.trim()) {
      return c.json({ error: { message: "template `name` is required" } }, 400);
    }
    const ks = getKapsoStore(store);
    const name = body.name.trim();
    const language = body.language ?? "es";
    const rejection = templateRejection(store);
    const review = rejection
      ? { status: "REJECTED", rejected_reason: rejection.reason }
      : { status: "APPROVED", rejected_reason: "NONE" };
    const existing = ks.templates
      .findBy("waba_id", wabaId)
      .find((template) => template.name === name && template.language === language);
    // Re-submitting an existing name re-reviews it with the new content
    // rather than returning Meta's duplicate error, so a consumer can fix a
    // rejected template and submit again under the same name.
    const template: KapsoTemplate = existing
      ? (ks.templates.update(existing.id, {
          category: body.category ?? existing.category,
          components: body.components ?? existing.components,
          ...review,
        }) ?? existing)
      : ks.templates.insert({
          template_id: kapsoTemplateId(),
          waba_id: wabaId,
          name,
          language,
          category: body.category ?? "UTILITY",
          components: body.components ?? [],
          ...review,
        });
    recordEvent(store, "template_created", wabaId, null, {
      template_id: template.template_id,
      name: template.name,
      status: template.status,
      reused: Boolean(existing),
    });
    return c.json({
      id: template.template_id,
      status: template.status,
      category: template.category,
    });
  });

  app.get("/meta/whatsapp/:version/:wabaId/message_templates", (c) => {
    const settings = getSettings(store);
    const denied = requireApiKey(c, settings);
    if (denied) return denied;
    const wabaId = c.req.param("wabaId");
    const name = c.req.query("name");
    const language = c.req.query("language");
    const ks = getKapsoStore(store);
    const rows = ks.templates
      .findBy("waba_id", wabaId)
      .filter((template) => !name || template.name === name)
      .filter((template) => !language || template.language === language)
      .map(templateResponse);
    return c.json({ data: rows });
  });

  // One template by ITS OWN id (`client.templates.get`), the read a status
  // reconcile switches to the moment it has adopted a Meta template id. The
  // listing alone is not a substitute: a consumer that polls by id against a
  // proxy answering 501 fails CLOSED forever, so a template campaign could be
  // dispatched exactly once — while the id was still null — and never again.
  app.get("/meta/whatsapp/:version/:wabaId/message_templates/:templateId", (c) => {
    const settings = getSettings(store);
    const denied = requireApiKey(c, settings);
    if (denied) return denied;
    const wabaId = c.req.param("wabaId");
    const templateId = c.req.param("templateId");
    const ks = getKapsoStore(store);
    const template = ks.templates.findOneBy("template_id", templateId);
    // Scoped to the WABA in the path: a template id belonging to another
    // account reads exactly like an unknown one, which is also what Meta says
    // (it does not distinguish "missing" from "not yours" here).
    if (!template || template.waba_id !== wabaId) {
      return c.json(
        {
          error: {
            message:
              `Unsupported get request. Object with ID '${templateId}' does not exist, ` +
              "cannot be loaded due to missing permissions, or does not support this operation.",
            type: "GraphMethodException",
            code: 100,
            error_subcode: 33,
            fbtrace_id: "kapso-emulator",
          },
        },
        404,
      );
    }
    return c.json(templateResponse(template));
  });
}

/** Catch-all for the rest of the Meta proxy: loud 501, registered last. */
export function metaProxyFallbackRoutes({ app }: RouteContext): void {
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    app.on(method, "/meta/whatsapp/:rest{.*}", (c) => notImplemented(c, "meta proxy"));
  }
}
