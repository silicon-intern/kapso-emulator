import { createHmac } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createKapsoEmulator, type KapsoEmulator } from "../src/server.js";

interface CapturedWebhook {
  event: string | undefined;
  signature: string | undefined;
  rawBody: string;
  body: Record<string, unknown>;
}

const WEBHOOK_SECRET = "test-webhook-secret";
const PHONE_NUMBER_ID = "pn-test-1";
const CUSTOMER = "59171234567";

let receiver: Server;
let received: CapturedWebhook[] = [];
let emulator: KapsoEmulator;

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function metaUrl(path: string): string {
  return `${emulator.url}/meta/whatsapp/v23.0${path}`;
}

async function sendText(body: string, to = CUSTOMER): Promise<Record<string, unknown>> {
  const response = await fetch(metaUrl(`/${PHONE_NUMBER_ID}/messages`), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": "any-key" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { body },
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

async function createTemplate(
  name: string,
  bodyText: string,
  footerText?: string,
): Promise<{ id: string; status: string }> {
  const response = await fetch(metaUrl("/waba-test-1/message_templates"), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": "any-key" },
    body: JSON.stringify({
      name,
      language: "es",
      category: "MARKETING",
      parameter_format: "POSITIONAL",
      components: [
        { type: "BODY", text: bodyText },
        ...(footerText ? [{ type: "FOOTER", text: footerText }] : []),
      ],
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { id: string; status: string };
}

async function platformJson(
  path: string,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(`${emulator.url}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": "any-key",
      ...(init.headers ?? {}),
    },
  });
  expect(response.status).toBeLessThan(500);
  return (await response.json()) as Record<string, unknown>;
}

async function createBroadcast(templateId: string): Promise<string> {
  // Platform responses are enveloped as { data } — the consuming client
  // (kapsoFetch) throws on a payload without it, so the tests unwrap too.
  const created = (await platformJson("/platform/v1/whatsapp/broadcasts", {
    method: "POST",
    body: JSON.stringify({
      whatsapp_broadcast: {
        name: "Carrera 42K",
        phone_number_id: PHONE_NUMBER_ID,
        whatsapp_template_id: templateId,
      },
    }),
  })) as { data: Record<string, unknown> };
  expect(created.data.status).toBe("draft");
  return created.data.id as string;
}

beforeAll(async () => {
  receiver = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      received.push({
        event: req.headers["x-webhook-event"] as string | undefined,
        signature: req.headers["x-webhook-signature"] as string | undefined,
        rawBody,
        body: JSON.parse(rawBody) as Record<string, unknown>,
      });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, resolve));
  const receiverPort = (receiver.address() as AddressInfo).port;
  emulator = await createKapsoEmulator({
    webhook: {
      url: `http://localhost:${receiverPort}/webhooks/kapso/whatsapp-message`,
      secret: WEBHOOK_SECRET,
    },
    echo_delay_ms: 0,
  });
});

afterAll(async () => {
  await emulator.close();
  await new Promise<void>((resolve, reject) =>
    receiver.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  received = [];
  emulator.reset();
});

describe("meta proxy sends", () => {
  it("accepts a text send and echoes a signed whatsapp.message.sent webhook", async () => {
    const result = await sendText("Hola, tu cita quedo confirmada");
    const messages = result.messages as Array<{ id: string }>;
    expect(messages[0]?.id).toMatch(/^wamid\.emu\./);

    await waitFor(() => received.length === 1);
    const webhook = received[0];
    expect(webhook.event).toBe("whatsapp.message.sent");
    const expected = createHmac("sha256", WEBHOOK_SECRET).update(webhook.rawBody).digest("hex");
    expect(webhook.signature).toBe(expected);

    const message = webhook.body.message as Record<string, unknown>;
    const kapso = message.kapso as Record<string, unknown>;
    expect(message.id).toBe(messages[0]?.id);
    expect(message.type).toBe("text");
    expect(kapso.direction).toBe("outbound");
    expect(kapso.origin).toBe("cloud_api");
    expect(kapso.content).toBe("Hola, tu cita quedo confirmada");
    const conversation = webhook.body.conversation as Record<string, unknown>;
    expect(conversation.phone_number).toBe(CUSTOMER);
    expect(webhook.body.phone_number_id).toBe(PHONE_NUMBER_ID);
  });

  it("requires an X-API-Key", async () => {
    const response = await fetch(metaUrl(`/${PHONE_NUMBER_ID}/messages`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: CUSTOMER, type: "text", text: { body: "hola" } }),
    });
    expect(response.status).toBe(401);
  });

  it("handles markRead + typing without creating a message", async () => {
    const response = await fetch(metaUrl(`/${PHONE_NUMBER_ID}/messages`), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": "any-key" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: "wamid.emu.000001",
        typing_indicator: { type: "text" },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });

    const events = (await (
      await fetch(`${emulator.url}/_kapso/simulate/events?after=0`)
    ).json()) as { events: Array<{ kind: string; data: Record<string, unknown> }> };
    const readEvent = events.events.find((event) => event.kind === "read_receipt");
    expect(readEvent?.data.typing).toBe(true);
    expect(received.length).toBe(0);
  });

  it("echoes template sends with the marker and serves message_type_data for rehydration", async () => {
    const response = await fetch(metaUrl(`/${PHONE_NUMBER_ID}/messages`), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": "any-key" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: CUSTOMER,
        type: "template",
        template: {
          name: "appointment_reminder",
          language: { code: "es" },
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: "Carla" },
                { type: "text", text: "manana 10:00" },
              ],
            },
          ],
        },
      }),
    });
    expect(response.status).toBe(200);

    await waitFor(() => received.length === 1);
    const message = received[0].body.message as Record<string, unknown>;
    const kapso = message.kapso as Record<string, unknown>;
    expect(kapso.content).toBe("[plantilla: appointment_reminder]");
    const conversationId = (received[0].body.conversation as Record<string, unknown>).id as string;

    const listing = (await (
      await fetch(
        `${emulator.url}/platform/v1/whatsapp/messages?conversation_id=${conversationId}&limit=20`,
        { headers: { "X-API-Key": "any-key" } },
      )
    ).json()) as { data: Array<Record<string, unknown>> };
    const row = listing.data.find((item) => item.id === message.id);
    const rowKapso = row?.kapso as Record<string, unknown>;
    const typeData = rowKapso.message_type_data as {
      name: string;
      components: Array<{ type: string; parameters: Array<{ text: string }> }>;
    };
    expect(typeData.name).toBe("appointment_reminder");
    expect(typeData.components[0].parameters.map((parameter) => parameter.text)).toEqual([
      "Carla",
      "manana 10:00",
    ]);
  });

  it("stores uploaded media and serves it back through the download URL", async () => {
    const bytes = Buffer.from("fake-image-bytes");
    const form = new FormData();
    form.set("messaging_product", "whatsapp");
    form.set("type", "image/jpeg");
    form.set("file", new File([bytes], "qr.jpg", { type: "image/jpeg" }));
    const upload = await fetch(metaUrl(`/${PHONE_NUMBER_ID}/media`), {
      method: "POST",
      headers: { "X-API-Key": "any-key" },
      body: form,
    });
    expect(upload.status).toBe(200);
    const { id } = (await upload.json()) as { id: string };
    expect(id).toMatch(/^media-emu-/);

    const metadata = (await (
      await fetch(metaUrl(`/${id}?phone_number_id=${PHONE_NUMBER_ID}`), {
        headers: { "X-API-Key": "any-key" },
      })
    ).json()) as { url: string; mime_type: string; file_size: number };
    expect(metadata.mime_type).toBe("image/jpeg");
    expect(metadata.file_size).toBe(bytes.byteLength);

    const download = await fetch(metadata.url);
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
  });

  it("refuses a typeless media upload with Meta's (#100) error, like real Graph", async () => {
    // The exact shape SDKs produce when handed a raw Buffer: FormData
    // serializes a typeless Blob part as application/octet-stream. Real Meta
    // validates the file PART's content type (the `type` form field does not
    // override it) and refuses; an accept-anything emulator hid that bug.
    const form = new FormData();
    form.set("messaging_product", "whatsapp");
    form.set("type", "image/jpeg");
    form.set("file", new Blob([Buffer.from("fake-image-bytes")]), "qr.jpg");
    const upload = await fetch(metaUrl(`/${PHONE_NUMBER_ID}/media`), {
      method: "POST",
      headers: { "X-API-Key": "any-key" },
      body: form,
    });
    expect(upload.status).toBe(400);
    const body = (await upload.json()) as { error: { message: string; code: number } };
    expect(body.error.code).toBe(100);
    expect(body.error.message).toContain("(#100) Param file must be a file with one of");
    expect(body.error.message).toContain("Received file of type 'application/octet-stream'");
  });

  it("refuses a send referencing an unknown media id with Meta's invalid-attachment error", async () => {
    // Media handles die with the app authorization on real Meta (a number
    // re-registration invalidates every previously minted id), so a cached id
    // can be rejected at send time while looking fresh. The accept-anything
    // emulator masks that whole failure class; an
    // unknown id gets the same Graph rejection so the cached-id recovery
    // paths are exercisable locally.
    const res = await fetch(metaUrl(`/${PHONE_NUMBER_ID}/messages`), {
      method: "POST",
      headers: { "X-API-Key": "any-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: "59170000001",
        type: "image",
        image: { id: "media-emu-long-gone" },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string; code: number; type: string } };
    expect(body.error.code).toBe(100);
    expect(body.error.type).toBe("OAuthException");
    expect(body.error.message).toBe(
      "Param image.id is not a valid whatsapp business account media attachment ID",
    );
  });

  it("501s loudly on unemulated meta and platform surfaces", async () => {
    const meta = await fetch(metaUrl("/waba-1/subscribed_apps"), {
      headers: { "X-API-Key": "any-key" },
    });
    expect(meta.status).toBe(501);
    const platform = await fetch(`${emulator.url}/platform/v1/whatsapp/setup_links`, {
      method: "POST",
      headers: { "X-API-Key": "any-key" },
    });
    expect(platform.status).toBe(501);
  });
});

describe("simulator surface", () => {
  it("injects an inbound text as a signed whatsapp.message.received webhook", async () => {
    const response = await fetch(`${emulator.url}/_kapso/simulate/inbound-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone_number_id: PHONE_NUMBER_ID,
        from: CUSTOMER,
        text: "quiero una cita para manana",
        contact_name: "Carla Flores",
      }),
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      wamid: string;
      kapso_conversation_id: string;
      delivery: { success: boolean; status_code: number };
    };
    expect(result.delivery.success).toBe(true);

    expect(received.length).toBe(1);
    const webhook = received[0];
    expect(webhook.event).toBe("whatsapp.message.received");
    const expected = createHmac("sha256", WEBHOOK_SECRET).update(webhook.rawBody).digest("hex");
    expect(webhook.signature).toBe(expected);
    const message = webhook.body.message as Record<string, unknown>;
    const kapso = message.kapso as Record<string, unknown>;
    expect(kapso.direction).toBe("inbound");
    expect(kapso.content).toBe("quiero una cita para manana");
    const conversation = webhook.body.conversation as Record<string, unknown>;
    expect(conversation.contact_name).toBe("Carla Flores");
    expect(conversation.id).toBe(result.kapso_conversation_id);
  });

  it("delivers business-app replies as sent webhooks with origin business_app", async () => {
    const response = await fetch(`${emulator.url}/_kapso/simulate/business-app-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone_number_id: PHONE_NUMBER_ID,
        from: CUSTOMER,
        text: "hola, soy el dueno, yo te atiendo",
      }),
    });
    expect(response.status).toBe(200);
    await waitFor(() => received.length === 1);
    const webhook = received[0];
    expect(webhook.event).toBe("whatsapp.message.sent");
    const message = webhook.body.message as Record<string, unknown>;
    const kapso = message.kapso as Record<string, unknown>;
    expect(kapso.direction).toBe("outbound");
    expect(kapso.origin).toBe("business_app");
    expect(kapso.content).toBe("hola, soy el dueno, yo te atiendo");
  });

  it("keeps one conversation id per thread and rotates it on demand", async () => {
    await sendText("primer mensaje");
    await sendText("segundo mensaje");
    await waitFor(() => received.length === 2);
    const first = (received[0].body.conversation as Record<string, unknown>).id;
    const second = (received[1].body.conversation as Record<string, unknown>).id;
    expect(first).toBe(second);

    const rotation = (await (
      await fetch(`${emulator.url}/_kapso/simulate/rotate-conversation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone_number_id: PHONE_NUMBER_ID, from: CUSTOMER }),
      })
    ).json()) as { kapso_conversation_id: string };
    expect(rotation.kapso_conversation_id).not.toBe(first);

    await sendText("tras la rotacion");
    await waitFor(() => received.length === 3);
    const third = (received[2].body.conversation as Record<string, unknown>).id;
    expect(third).toBe(rotation.kapso_conversation_id);
  });

  it("resets state but keeps webhook wiring", async () => {
    await sendText("antes del reset");
    await waitFor(() => received.length === 1);
    const reset = await fetch(`${emulator.url}/_kapso/simulate/reset`, { method: "POST" });
    expect(reset.status).toBe(200);

    const thread = (await (
      await fetch(
        `${emulator.url}/_kapso/simulate/thread?phone_number_id=${PHONE_NUMBER_ID}&from=${CUSTOMER}`,
      )
    ).json()) as { conversation: unknown; messages: unknown[] };
    expect(thread.conversation).toBeNull();
    expect(thread.messages).toEqual([]);

    await sendText("despues del reset");
    await waitFor(() => received.length === 2);
    expect(received[1].event).toBe("whatsapp.message.sent");
  });

  it("persists state across a restart when state_file is set", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const stateFile = join(await mkdtemp(join(tmpdir(), "kapso-emu-")), "state.json");

    const first = await createKapsoEmulator({ echo_delay_ms: 0, state_file: stateFile });
    const form = new FormData();
    form.set("messaging_product", "whatsapp");
    form.set("type", "image/png");
    form.set(
      "file",
      new File([Buffer.from("persistent-bytes")], "keep.png", { type: "image/png" }),
    );
    const upload = await fetch(`${first.url}/meta/whatsapp/v23.0/${PHONE_NUMBER_ID}/media`, {
      method: "POST",
      headers: { "X-API-Key": "any-key" },
      body: form,
    });
    const { id } = (await upload.json()) as { id: string };
    await first.close();

    const second = await createKapsoEmulator({ echo_delay_ms: 0, state_file: stateFile });
    try {
      const download = await fetch(`${second.url}/media-files/${id}`);
      expect(download.status).toBe(200);
      expect(Buffer.from(await download.arrayBuffer()).toString()).toBe("persistent-bytes");
    } finally {
      await second.close();
    }
  });

  it("serves the ephemeral event feed with a cursor", async () => {
    await sendText("evento uno");
    const firstPage = (await (
      await fetch(`${emulator.url}/_kapso/simulate/events?after=0`)
    ).json()) as { events: Array<{ seq: number; kind: string }>; last_seq: number };
    expect(firstPage.events.some((event) => event.kind === "outbound_message")).toBe(true);

    const secondPage = (await (
      await fetch(`${emulator.url}/_kapso/simulate/events?after=${firstPage.last_seq}`)
    ).json()) as { events: Array<{ seq: number }> };
    const newSeqs = secondPage.events.map((event) => event.seq);
    expect(newSeqs.every((seq) => seq > firstPage.last_seq)).toBe(true);
  });
});

describe("waba message templates", () => {
  it("creates instantly-approved templates and lists them by name", async () => {
    const created = await createTemplate("mkt_carrera_42k_ab12cd", "Hola {{1}}, corre el 42K");
    expect(created.id).toMatch(/^tmpl-emu-/);
    expect(created.status).toBe("APPROVED");

    // Re-submitting the same name returns the stored row, never a duplicate.
    const again = await createTemplate("mkt_carrera_42k_ab12cd", "Hola {{1}}, corre el 42K");
    expect(again.id).toBe(created.id);

    const listing = (await (
      await fetch(metaUrl("/waba-test-1/message_templates?name=mkt_carrera_42k_ab12cd"), {
        headers: { "X-API-Key": "any-key" },
      })
    ).json()) as { data: Array<Record<string, unknown>> };
    expect(listing.data).toHaveLength(1);
    expect(listing.data[0].name).toBe("mkt_carrera_42k_ab12cd");
    expect(listing.data[0].status).toBe("APPROVED");
  });

  it("serves a created template back by its own id, in the listing's shape", async () => {
    const created = await createTemplate("mkt_por_id_7a1b2c", "Hola {{1}}, volve pronto.");

    const response = await fetch(metaUrl(`/waba-test-1/message_templates/${created.id}`), {
      headers: { "X-API-Key": "any-key" },
    });
    expect(response.status).toBe(200);
    const template = (await response.json()) as Record<string, unknown>;
    expect(template.id).toBe(created.id);
    expect(template.name).toBe("mkt_por_id_7a1b2c");
    expect(template.status).toBe("APPROVED");
    expect(template.category).toBe("MARKETING");
    expect(template.language).toBe("es");
    // A status reconcile keys on this field; "NONE" is Meta's own value for a
    // template that was not rejected.
    expect(template.rejected_reason).toBe("NONE");

    // Byte-identical to the listing row, so a reconcile that switches from
    // find-by-name to read-by-id cannot see a different template.
    const listing = (await (
      await fetch(metaUrl("/waba-test-1/message_templates?name=mkt_por_id_7a1b2c"), {
        headers: { "X-API-Key": "any-key" },
      })
    ).json()) as { data: Array<Record<string, unknown>> };
    expect(listing.data[0]).toEqual(template);
  });

  it("404s an unknown template id instead of 501ing through the proxy fallback", async () => {
    const response = await fetch(metaUrl("/waba-test-1/message_templates/tmpl-does-not-exist"), {
      headers: { "X-API-Key": "any-key" },
    });
    // A 501 here reads as "Meta unreachable" to a consumer that fails closed,
    // stranding its template dispatch forever.
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(100);
    expect(body.error.message).toContain("does not exist");
  });

  it("hides a template from a WABA that does not own it", async () => {
    const created = await createTemplate("mkt_otro_waba_5c4d3e", "Hola {{1}}.");
    const response = await fetch(metaUrl(`/waba-other-1/message_templates/${created.id}`), {
      headers: { "X-API-Key": "any-key" },
    });
    expect(response.status).toBe(404);
  });

  it("requires an X-API-Key to read a template by id", async () => {
    const response = await fetch(metaUrl("/waba-test-1/message_templates/tmpl-anything"));
    expect(response.status).toBe(401);
  });
});

describe("platform phone numbers", () => {
  it("resolves a number to a stable WABA id templates can be created under", async () => {
    const first = (await platformJson(
      `/platform/v1/whatsapp/phone_numbers/${PHONE_NUMBER_ID}`,
    )) as { data: Record<string, unknown> };
    expect(first.data.id).toBe(PHONE_NUMBER_ID);
    expect(typeof first.data.whatsapp_business_account_id).toBe("string");
    expect(first.data.display_phone_number).toBeTruthy();

    // Stable across lookups: a consumer that persists the resolved WABA and a
    // later one that re-resolves it must land on the same account.
    const second = (await platformJson(
      `/platform/v1/whatsapp/phone_numbers/${PHONE_NUMBER_ID}`,
    )) as { data: Record<string, unknown> };
    expect(second.data.whatsapp_business_account_id).toBe(first.data.whatsapp_business_account_id);

    // And the resolved WABA is a real account here: creating under it and
    // reading the result back by id is the whole point of the lookup.
    const wabaId = first.data.whatsapp_business_account_id as string;
    const created = (await (
      await fetch(metaUrl(`/${wabaId}/message_templates`), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": "any-key" },
        body: JSON.stringify({
          name: "mkt_desde_numero_9d8e",
          language: "es",
          category: "MARKETING",
          components: [{ type: "BODY", text: "Hola {{1}}." }],
        }),
      })
    ).json()) as { id: string };
    const readBack = await fetch(metaUrl(`/${wabaId}/message_templates/${created.id}`), {
      headers: { "X-API-Key": "any-key" },
    });
    expect(readBack.status).toBe(200);
    expect(((await readBack.json()) as { status: string }).status).toBe("APPROVED");
  });

  it("requires an X-API-Key", async () => {
    const response = await fetch(
      `${emulator.url}/platform/v1/whatsapp/phone_numbers/${PHONE_NUMBER_ID}`,
    );
    expect(response.status).toBe(401);
  });
});

describe("broadcasts", () => {
  it("runs create, add recipients, send: per-recipient marker echoes plus rendered platform rows", async () => {
    const template = await createTemplate(
      "mkt_vuelve_9f8e7d",
      "Hola {{1}}, te extranamos.",
      "Responde BAJA para no recibir mas mensajes.",
    );
    const broadcastId = await createBroadcast(template.id);

    const { data: summary } = (await platformJson(
      `/platform/v1/whatsapp/broadcasts/${broadcastId}/recipients`,
      {
        method: "POST",
        body: JSON.stringify({
          whatsapp_broadcast: {
            recipients: [
              {
                phone_number: "59171000001",
                components: [{ type: "body", parameters: [{ type: "text", text: "Ana" }] }],
              },
              {
                phone_number: "59171000002",
                components: [{ type: "body", parameters: [{ type: "text", text: "Bruno" }] }],
              },
              { phone_number: "59171000001" },
              { phone_number: "no-digits" },
            ],
          },
        }),
      },
    )) as { data: Record<string, unknown> };
    expect(summary.added).toBe(2);
    expect(summary.duplicates).toBe(1);
    expect((summary.errors as string[]).length).toBe(1);

    const { data: sent } = (await platformJson(
      `/platform/v1/whatsapp/broadcasts/${broadcastId}/send`,
      { method: "POST" },
    )) as { data: Record<string, unknown> };
    expect(sent.status).toBe("completed");
    expect(sent.sent_count).toBe(2);
    expect(sent.delivered_count).toBe(2);

    // One signed sent echo per recipient, carrying the RENDERED body — the
    // shape real Kapso broadcasts echo; the
    // per-recipient params make each echo's text its own.
    await waitFor(() => received.length === 2);
    const echoContents = received.map((webhook) => {
      expect(webhook.event).toBe("whatsapp.message.sent");
      const message = webhook.body.message as Record<string, unknown>;
      const kapso = message.kapso as Record<string, unknown>;
      expect(kapso.origin).toBe("cloud_api");
      return kapso.content as string;
    });
    expect(echoContents.sort()).toEqual([
      "Hola Ana, te extranamos.\n\nResponde BAJA para no recibir mas mensajes.",
      "Hola Bruno, te extranamos.\n\nResponde BAJA para no recibir mas mensajes.",
    ]);

    // The platform listing serves the RENDERED body for rehydration.
    const anaEcho = received.find(
      (webhook) =>
        (webhook.body.conversation as Record<string, unknown>).phone_number === "59171000001",
    );
    if (!anaEcho) throw new Error("expected a sent echo for Ana's phone");
    const conversationId = (anaEcho.body.conversation as Record<string, unknown>).id as string;
    const listing = (await platformJson(
      `/platform/v1/whatsapp/messages?conversation_id=${conversationId}&limit=20`,
    )) as { data: Array<Record<string, unknown>> };
    const row = listing.data.find(
      (item) => item.id === (anaEcho.body.message as Record<string, unknown>).id,
    );
    const rowKapso = row?.kapso as Record<string, unknown>;
    expect(rowKapso.content).toBe(
      "Hola Ana, te extranamos.\n\nResponde BAJA para no recibir mas mensajes.",
    );
    const typeData = rowKapso.message_type_data as { name: string };
    expect(typeData.name).toBe("mkt_vuelve_9f8e7d");

    // Draft-only guards: a second send and a late recipient add both refuse.
    const resend = await fetch(
      `${emulator.url}/platform/v1/whatsapp/broadcasts/${broadcastId}/send`,
      { method: "POST", headers: { "X-API-Key": "any-key" } },
    );
    expect(resend.status).toBe(422);
    const lateAdd = await fetch(
      `${emulator.url}/platform/v1/whatsapp/broadcasts/${broadcastId}/recipients`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": "any-key" },
        body: JSON.stringify({
          whatsapp_broadcast: { recipients: [{ phone_number: "59171000003" }] },
        }),
      },
    );
    expect(lateAdd.status).toBe(422);
  });

  it("refuses a broadcast whose whatsapp_template_id is unknown", async () => {
    const response = await fetch(`${emulator.url}/platform/v1/whatsapp/broadcasts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": "any-key" },
      body: JSON.stringify({
        whatsapp_broadcast: {
          name: "Fantasma",
          phone_number_id: PHONE_NUMBER_ID,
          whatsapp_template_id: "tmpl-none",
        },
      }),
    });
    expect(response.status).toBe(404);
  });

  it("caps recipient pages server-side and reports total_pages as the stop authority", async () => {
    const template = await createTemplate("mkt_paginado_aa11bb", "Promo para vos");
    const broadcastId = await createBroadcast(template.id);
    const recipients = Array.from({ length: 60 }, (_, index) => ({
      phone_number: `5917200${String(index).padStart(4, "0")}`,
    }));
    await platformJson(`/platform/v1/whatsapp/broadcasts/${broadcastId}/recipients`, {
      method: "POST",
      body: JSON.stringify({ whatsapp_broadcast: { recipients } }),
    });
    await platformJson(`/platform/v1/whatsapp/broadcasts/${broadcastId}/send`, {
      method: "POST",
    });

    const page = (await platformJson(
      `/platform/v1/whatsapp/broadcasts/${broadcastId}/recipients?page=1&per_page=100`,
    )) as { data: Array<Record<string, unknown>>; meta: Record<string, unknown> };
    // The 100 requested is capped to 50, exactly the production trap the
    // consuming sync pages through via meta.total_pages.
    expect(page.data).toHaveLength(50);
    expect(page.meta.per_page).toBe(50);
    expect(page.meta.total_pages).toBe(2);
    expect(page.meta.total_count).toBe(60);

    const second = (await platformJson(
      `/platform/v1/whatsapp/broadcasts/${broadcastId}/recipients?page=2&per_page=100`,
    )) as { data: Array<Record<string, unknown>> };
    expect(second.data).toHaveLength(10);
  });

  it("advances a recipient to responded when the simulated customer replies", async () => {
    const template = await createTemplate("mkt_respuesta_cc22dd", "Volve pronto");
    const broadcastId = await createBroadcast(template.id);
    await platformJson(`/platform/v1/whatsapp/broadcasts/${broadcastId}/recipients`, {
      method: "POST",
      body: JSON.stringify({
        whatsapp_broadcast: { recipients: [{ phone_number: "59171000009" }] },
      }),
    });
    await platformJson(`/platform/v1/whatsapp/broadcasts/${broadcastId}/send`, {
      method: "POST",
    });

    const inbound = await fetch(`${emulator.url}/_kapso/simulate/inbound-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone_number_id: PHONE_NUMBER_ID,
        from: "59171000009",
        text: "Si, quiero!",
      }),
    });
    expect(inbound.status).toBe(200);

    const listing = (await platformJson(
      `/platform/v1/whatsapp/broadcasts/${broadcastId}/recipients?page=1`,
    )) as { data: Array<Record<string, unknown>> };
    expect(listing.data[0].status).toBe("responded");
    expect(listing.data[0].read_at).not.toBeNull();
    expect(listing.data[0].responded_at).not.toBeNull();
    const { data: counters } = (await platformJson(
      `/platform/v1/whatsapp/broadcasts/${broadcastId}`,
    )) as { data: Record<string, unknown> };
    expect(counters.responded_count).toBe(1);
    expect(counters.read_count).toBe(1);
  });
});
