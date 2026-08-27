import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createKapsoEmulator, type KapsoEmulator } from "../src/server.js";

const PHONE_NUMBER_ID = "pn-hardening-1";
const CUSTOMER = "59170000009";

let receiver: Server;
let received: number;
let emulator: KapsoEmulator;

beforeAll(async () => {
  receiver = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      received += 1;
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, resolve));
  const port = (receiver.address() as AddressInfo).port;
  emulator = await createKapsoEmulator({
    webhook: { url: `http://localhost:${port}/hook`, secret: "test-secret" },
    echo_delay_ms: 0,
  });
});

afterAll(async () => {
  await emulator.close();
  receiver.close();
});

beforeEach(() => {
  emulator.reset();
  received = 0;
});

function metaUrl(path: string): string {
  return `${emulator.url}/meta/whatsapp/v23.0${path}`;
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": "any-key" },
    body: JSON.stringify(body),
  });
}

async function createTemplate(
  wabaId: string,
  name: string,
  bodyText: string,
): Promise<{ id: string; status: string }> {
  const response = await postJson(metaUrl(`/${wabaId}/message_templates`), {
    name,
    language: "es",
    category: "UTILITY",
    components: [{ type: "BODY", text: bodyText }],
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { id: string; status: string };
}

describe("malformed input never escapes as a bare 500", () => {
  it("rejects a numeric `to` with a JSON 400", async () => {
    const response = await postJson(metaUrl(`/${PHONE_NUMBER_ID}/messages`), {
      messaging_product: "whatsapp",
      to: 59177777777,
      type: "text",
      text: { body: "x" },
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain(
      "`to`",
    );
  });

  it("rejects a numeric `from` on both simulator inject routes", async () => {
    for (const path of ["inbound-message", "business-app-message"]) {
      const response = await postJson(`${emulator.url}/_kapso/simulate/${path}`, {
        phone_number_id: PHONE_NUMBER_ID,
        from: 59170000009,
        text: "hola",
      });
      expect(response.status).toBe(400);
    }
  });

  it("collects bad recipient entries into errors[] instead of crashing mid-insert", async () => {
    const template = await createTemplate(`waba-${PHONE_NUMBER_ID}`, "hard_blast", "Hola {{1}}");
    const create = await postJson(`${emulator.url}/platform/v1/whatsapp/broadcasts`, {
      whatsapp_broadcast: {
        name: "hardening",
        phone_number_id: PHONE_NUMBER_ID,
        whatsapp_template_id: template.id,
      },
    });
    const broadcast = ((await create.json()) as { data: { id: string } }).data;
    const add = await postJson(
      `${emulator.url}/platform/v1/whatsapp/broadcasts/${broadcast.id}/recipients`,
      {
        whatsapp_broadcast: {
          recipients: [
            { phone_number: "59177000001" },
            { phone_number: 59177000002 },
            null,
            { phone_number: "59177000003" },
          ],
        },
      },
    );
    expect(add.status).toBe(200);
    const result = (
      (await add.json()) as {
        data: { added: number; duplicates: number; errors: string[] };
      }
    ).data;
    expect(result.added).toBe(2);
    expect(result.errors.length).toBe(2);
  });

  it("does not crash on a non-array interactive sections", async () => {
    const response = await postJson(metaUrl(`/${PHONE_NUMBER_ID}/messages`), {
      messaging_product: "whatsapp",
      to: CUSTOMER,
      type: "interactive",
      interactive: { type: "list", body: { text: "elige" }, action: { sections: "nope" } },
    });
    expect(response.status).toBe(200);
  });

  it("rejects a string `components` at template create", async () => {
    const response = await postJson(metaUrl(`/waba-${PHONE_NUMBER_ID}/message_templates`), {
      name: "bad_components",
      language: "es",
      components: "BODY",
    });
    expect(response.status).toBe(400);
  });

  it("rejects inbound media missing data_base64", async () => {
    const response = await postJson(`${emulator.url}/_kapso/simulate/inbound-message`, {
      phone_number_id: PHONE_NUMBER_ID,
      from: CUSTOMER,
      media: { content_type: "image/png" },
    });
    expect(response.status).toBe(400);
  });

  it("accepts an inbound sticker", async () => {
    const response = await postJson(`${emulator.url}/_kapso/simulate/inbound-message`, {
      phone_number_id: PHONE_NUMBER_ID,
      from: CUSTOMER,
      type: "sticker",
      media: { content_type: "image/webp", data_base64: Buffer.from("webp").toString("base64") },
    });
    expect(response.status).toBe(200);
  });
});

describe("failure-rule validation", () => {
  async function setFailures(rules: unknown): Promise<Response> {
    return fetch(`${emulator.url}/_kapso/simulate/failures`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rules),
    });
  }

  it("rejects malformed known rules instead of silently arming them", async () => {
    expect((await setFailures({ send: "oops" })).status).toBe(400);
    expect((await setFailures({ send: { times: "two" } })).status).toBe(400);
    expect((await setFailures({ send: { times: -1 } })).status).toBe(400);
    expect((await setFailures({ broadcast: { phones: [123] } })).status).toBe(400);
    expect((await setFailures({ template_review: "REJECTED" })).status).toBe(400);
  });

  it("rejects an http_status the Response constructor would crash on", async () => {
    for (const status of [204, 999, 0]) {
      const response = await setFailures({ send: { error: { http_status: status } } });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { message: string } }).error.message).toContain(
        "http_status",
      );
    }
    expect((await setFailures({ send: { error: { http_status: 503 } } })).status).toBe(200);
  });
});

describe("template approval is enforced downstream", () => {
  it("refuses sending a REJECTED registered template with Meta's 132001", async () => {
    await fetch(`${emulator.url}/_kapso/simulate/failures`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template_review: { status: "REJECTED" } }),
    });
    await createTemplate(`waba-${PHONE_NUMBER_ID}`, "rechazada", "Hola {{1}}");
    const send = await postJson(metaUrl(`/${PHONE_NUMBER_ID}/messages`), {
      messaging_product: "whatsapp",
      to: CUSTOMER,
      type: "template",
      template: { name: "rechazada", language: { code: "es" } },
    });
    expect(send.status).toBe(400);
    expect(((await send.json()) as { error: { code: number } }).error.code).toBe(132001);
  });

  it("refuses creating a broadcast on a non-APPROVED template", async () => {
    await fetch(`${emulator.url}/_kapso/simulate/failures`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template_review: { status: "REJECTED" } }),
    });
    const template = await createTemplate(`waba-${PHONE_NUMBER_ID}`, "blast_rechazada", "Hola");
    const create = await postJson(`${emulator.url}/platform/v1/whatsapp/broadcasts`, {
      whatsapp_broadcast: {
        name: "no va",
        phone_number_id: PHONE_NUMBER_ID,
        whatsapp_template_id: template.id,
      },
    });
    expect(create.status).toBe(422);
  });
});

describe("template lookup scoping", () => {
  it("prefers the sender's own WABA over a same-named foreign template", async () => {
    await createTemplate(`waba-${PHONE_NUMBER_ID}`, "dos_slots", "A={{1}}");
    await createTemplate("waba-otra-cuenta", "dos_slots", "OTRA CUENTA: {{1}}");
    const send = await postJson(metaUrl(`/${PHONE_NUMBER_ID}/messages`), {
      messaging_product: "whatsapp",
      to: CUSTOMER,
      type: "template",
      template: {
        name: "dos_slots",
        language: { code: "es" },
        components: [{ type: "body", parameters: [{ type: "text", text: "X" }] }],
      },
    });
    expect(send.status).toBe(200);
    const wamid = ((await send.json()) as { messages: Array<{ id: string }> }).messages[0].id;
    const thread = (await (
      await fetch(
        `${emulator.url}/_kapso/simulate/thread?phone_number_id=${PHONE_NUMBER_ID}&from=${CUSTOMER}`,
      )
    ).json()) as { messages: Array<{ wamid: string; rendered_content: string | null }> };
    const row = thread.messages.find((message) => message.wamid === wamid);
    expect(row?.rendered_content).toBe("A=X");
  });
});

describe("fallbacks and reset semantics", () => {
  it("answers the bare surface prefixes with a gated loud 501", async () => {
    for (const path of ["/meta/whatsapp", "/platform", "/meta/whatsapp/v23.0", "/platform/v1"]) {
      const unauthenticated = await fetch(`${emulator.url}${path}`);
      expect(unauthenticated.status).toBe(401);
      const authenticated = await fetch(`${emulator.url}${path}`, {
        headers: { "X-API-Key": "any-key" },
      });
      expect(authenticated.status).toBe(501);
      expect(((await authenticated.json()) as { error: string }).error).toBe("not_implemented");
    }
  });

  it("keeps the event cursor monotonic across reset", async () => {
    await postJson(`${emulator.url}/_kapso/simulate/inbound-message`, {
      phone_number_id: PHONE_NUMBER_ID,
      from: CUSTOMER,
      text: "antes del reset",
    });
    const before = (await (await fetch(`${emulator.url}/_kapso/simulate/events`)).json()) as {
      last_seq: number;
    };
    expect(before.last_seq).toBeGreaterThan(0);

    await fetch(`${emulator.url}/_kapso/simulate/reset`, { method: "POST" });
    await postJson(`${emulator.url}/_kapso/simulate/inbound-message`, {
      phone_number_id: PHONE_NUMBER_ID,
      from: CUSTOMER,
      text: "despues del reset",
    });
    const after = (await (
      await fetch(`${emulator.url}/_kapso/simulate/events?after=${before.last_seq}`)
    ).json()) as { events: Array<{ kind: string }>; last_seq: number };
    expect(after.events.length).toBeGreaterThan(0);
    expect(after.last_seq).toBeGreaterThan(before.last_seq);
  });

  it("clamps an out-of-range event cursor back to the real max", async () => {
    await postJson(`${emulator.url}/_kapso/simulate/inbound-message`, {
      phone_number_id: PHONE_NUMBER_ID,
      from: CUSTOMER,
      text: "hola",
    });
    const page = (await (
      await fetch(`${emulator.url}/_kapso/simulate/events?after=999999`)
    ).json()) as { events: unknown[]; last_seq: number };
    expect(page.events.length).toBe(0);
    expect(page.last_seq).toBeLessThan(999999);
  });
});

describe("stored content stays a string", () => {
  it("rejects an object text.body instead of storing it", async () => {
    const response = await postJson(metaUrl(`/${PHONE_NUMBER_ID}/messages`), {
      messaging_product: "whatsapp",
      to: CUSTOMER,
      type: "text",
      text: { body: { nested: true } },
    });
    expect(response.status).toBe(400);
    const inspector = await fetch(`${emulator.url}/`);
    expect(inspector.status).toBe(200);
  });

  it("survives null rows and null template parameters", async () => {
    const list = await postJson(metaUrl(`/${PHONE_NUMBER_ID}/messages`), {
      messaging_product: "whatsapp",
      to: CUSTOMER,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: "elige" },
        action: { sections: [{ rows: [null, { title: "Corte" }] }] },
      },
    });
    expect(list.status).toBe(200);

    await createTemplate(`waba-${PHONE_NUMBER_ID}`, "null_param", "Hola {{1}}");
    const send = await postJson(metaUrl(`/${PHONE_NUMBER_ID}/messages`), {
      messaging_product: "whatsapp",
      to: CUSTOMER,
      type: "template",
      template: {
        name: "null_param",
        language: { code: "es" },
        components: [{ type: "body", parameters: [null, { type: "text", text: "Ana" }] }],
      },
    });
    expect(send.status).toBe(200);
    expect((await fetch(`${emulator.url}/`)).status).toBe(200);
  });
});
