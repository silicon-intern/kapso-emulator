import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FailureRules } from "../src/failures.js";
import { createKapsoEmulator, type KapsoEmulator } from "../src/server.js";

const PHONE_NUMBER_ID = "pn-failures-1";
const WABA_ID = "waba-failures-1";
const CUSTOMER = "59170000001";
const OTHER_CUSTOMER = "59170000002";

interface CapturedWebhook {
  event: string | undefined;
  body: Record<string, unknown>;
}

let receiver: Server;
let received: CapturedWebhook[] = [];
let emulator: KapsoEmulator;

beforeAll(async () => {
  receiver = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      received.push({
        event: req.headers["x-webhook-event"] as string | undefined,
        body: JSON.parse(raw) as Record<string, unknown>,
      });
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
  received = [];
});

async function setFailures(rules: FailureRules): Promise<Response> {
  return fetch(`${emulator.url}/_kapso/simulate/failures`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rules),
  });
}

async function readFailures(): Promise<FailureRules> {
  const response = await fetch(`${emulator.url}/_kapso/simulate/failures`);
  return (await response.json()) as FailureRules;
}

async function sendText(body: string, to = CUSTOMER): Promise<Response> {
  return fetch(`${emulator.url}/meta/whatsapp/v23.0/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": "any-key" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } }),
  });
}

async function createTemplate(name: string): Promise<{ id: string; status: string }> {
  const response = await fetch(`${emulator.url}/meta/whatsapp/v23.0/${WABA_ID}/message_templates`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": "any-key" },
    body: JSON.stringify({
      name,
      language: "es",
      category: "MARKETING",
      components: [{ type: "BODY", text: "Hola {{1}}" }],
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { id: string; status: string };
}

async function readTemplate(
  templateId: string,
): Promise<{ status: string; rejected_reason: string }> {
  const response = await fetch(
    `${emulator.url}/meta/whatsapp/v23.0/${WABA_ID}/message_templates/${templateId}`,
    { headers: { "X-API-Key": "any-key" } },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { status: string; rejected_reason: string };
}

describe("send failures", () => {
  it("fails sends with the default Graph error until the rule is cleared", async () => {
    await setFailures({ send: {} });
    const failed = await sendText("hola");
    expect(failed.status).toBe(400);
    const body = (await failed.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(131026);
    expect(body.error.message).toContain("131026");

    await fetch(`${emulator.url}/_kapso/simulate/failures`, { method: "DELETE" });
    expect((await sendText("hola de nuevo")).status).toBe(200);
  });

  it("scopes to a phone, honors error overrides, and counts down times", async () => {
    await setFailures({
      send: {
        to: "+591 7000-0001",
        times: 1,
        error: { code: 130429, message: "Rate limit hit", http_status: 429 },
      },
    });
    expect((await sendText("unaffected", OTHER_CUSTOMER)).status).toBe(200);

    const failed = await sendText("throttled", CUSTOMER);
    expect(failed.status).toBe(429);
    expect(((await failed.json()) as { error: { code: number } }).error.code).toBe(130429);

    expect((await sendText("recovered", CUSTOMER)).status).toBe(200);
    expect((await readFailures()).send).toBeUndefined();
  });

  it("leaves no message row and no echo behind a failed send", async () => {
    await setFailures({ send: { times: 1 } });
    await sendText("never happened");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received.length).toBe(0);
    const thread = (await (
      await fetch(
        `${emulator.url}/_kapso/simulate/thread?phone_number_id=${PHONE_NUMBER_ID}&from=${CUSTOMER}`,
      )
    ).json()) as { messages: unknown[] };
    expect(thread.messages.length).toBe(0);
  });
});

describe("template review failures", () => {
  it("rejects at create, reflects it on the by-id read, and re-approves on resubmit", async () => {
    await setFailures({ template_review: { status: "REJECTED", reason: "ABUSIVE_CONTENT" } });
    const created = await createTemplate("promo_prueba");
    expect(created.status).toBe("REJECTED");
    const read = await readTemplate(created.id);
    expect(read.status).toBe("REJECTED");
    expect(read.rejected_reason).toBe("ABUSIVE_CONTENT");

    await fetch(`${emulator.url}/_kapso/simulate/failures`, { method: "DELETE" });
    const resubmitted = await createTemplate("promo_prueba");
    expect(resubmitted.id).toBe(created.id);
    expect(resubmitted.status).toBe("APPROVED");
    expect((await readTemplate(created.id)).rejected_reason).toBe("NONE");
  });
});

describe("broadcast failures", () => {
  it("fails listed recipients during fan-out while the rest deliver and echo", async () => {
    const template = await createTemplate("blast_prueba");
    const createResponse = await fetch(`${emulator.url}/platform/v1/whatsapp/broadcasts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": "any-key" },
      body: JSON.stringify({
        whatsapp_broadcast: {
          name: "prueba",
          phone_number_id: PHONE_NUMBER_ID,
          whatsapp_template_id: template.id,
        },
      }),
    });
    const broadcast = ((await createResponse.json()) as { data: { id: string } }).data;
    await fetch(`${emulator.url}/platform/v1/whatsapp/broadcasts/${broadcast.id}/recipients`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": "any-key" },
      body: JSON.stringify({
        whatsapp_broadcast: {
          recipients: [{ phone_number: CUSTOMER }, { phone_number: OTHER_CUSTOMER }],
        },
      }),
    });
    await setFailures({
      broadcast: { phones: [OTHER_CUSTOMER], error_message: "Number no longer on WhatsApp" },
    });

    const sendResponse = await fetch(
      `${emulator.url}/platform/v1/whatsapp/broadcasts/${broadcast.id}/send`,
      { method: "POST", headers: { "X-API-Key": "any-key" } },
    );
    const sent = (
      (await sendResponse.json()) as {
        data: { delivered_count: number; failed_count: number };
      }
    ).data;
    expect(sent.delivered_count).toBe(1);
    expect(sent.failed_count).toBe(1);

    const listing = (await (
      await fetch(`${emulator.url}/platform/v1/whatsapp/broadcasts/${broadcast.id}/recipients`, {
        headers: { "X-API-Key": "any-key" },
      })
    ).json()) as {
      data: Array<{ phone_number: string; status: string; error_message: string | null }>;
    };
    const failedRow = listing.data.find((row) => row.phone_number === OTHER_CUSTOMER);
    expect(failedRow?.status).toBe("failed");
    expect(failedRow?.error_message).toBe("Number no longer on WhatsApp");

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received.length).toBe(1);
  });
});

describe("failure rule management", () => {
  it("validates rule bodies with helpful errors", async () => {
    const unknown = await setFailures({ nope: true } as unknown as FailureRules);
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: { message: string } }).error.message).toContain(
      "Unknown failure rule",
    );

    const badStatus = await setFailures({
      template_review: { status: "APPROVED" },
    } as unknown as FailureRules);
    expect(badStatus.status).toBe(400);
  });

  it("simulate/reset clears the rules", async () => {
    await setFailures({ send: {} });
    await fetch(`${emulator.url}/_kapso/simulate/reset`, { method: "POST" });
    expect((await readFailures()).send).toBeUndefined();
    expect((await sendText("after reset")).status).toBe(200);
  });
});
