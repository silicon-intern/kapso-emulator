# kapso-emulator

Test your entire WhatsApp flow locally, including signed webhooks. Avoid surprises in production.

Local emulator for the [Kapso](https://kapso.ai) WhatsApp platform. It stands in for the two surfaces a Kapso app consumes — the Meta Graph proxy (`api.kapso.ai/meta/whatsapp`) and the Platform API (`app.kapso.ai/platform/v1`) — and loops every accepted send back to your app as a signed webhook. Your WhatsApp product runs end to end on localhost: no phone number, no Meta review wait, zero real messages.

![Your unchanged stack points at localhost:4300 instead of Kapso cloud and Meta; every accepted send echoes back as a signed webhook.](https://raw.githubusercontent.com/silicon-intern/kapso-emulator/main/docs/images/high-level-architecture.jpg)

- **Same wire shapes.** Sends, media, templates, broadcasts, and signed `whatsapp.message.*` webhooks match what Kapso emits in production — down to Meta's exact Graph errors.
- **Instant template approval.** Real Meta review takes ~24h; the emulator approves at create.
- **Failure injection.** Have it reject templates, refuse sends, or fail broadcast recipients — the errors you cannot provoke on demand against production.
- **Loud gaps.** Anything not emulated answers `501 not_implemented` with the method and path, never a fake success.

## Run

```bash
npx kapso-emulator \
  --webhook-url http://localhost:3000/webhooks/kapso \
  --webhook-secret your-webhook-secret
```

Point your app's Kapso base URLs at it (default port 4300) — any non-empty `X-API-Key` is accepted unless you pin one with `--api-key`:

| Production | Emulator |
|---|---|
| `https://api.kapso.ai/meta/whatsapp/v23.0/...` | `http://localhost:4300/meta/whatsapp/v23.0/...` |
| `https://app.kapso.ai/platform/v1/...` | `http://localhost:4300/platform/v1/...` |

Then have a customer write in — any `phone_number_id` works; numbers spring into existence on first use:

```bash
curl -X POST http://localhost:4300/_kapso/simulate/inbound-message \
  -H 'Content-Type: application/json' \
  -d '{"phone_number_id": "555111222333", "from": "59171234567", "text": "Hola!"}'
```

Your webhook target receives a signed `whatsapp.message.received`. Reply the way your app does — a normal Meta Graph send against the emulator — and it echoes back ~300ms later as a signed `whatsapp.message.sent`: the same loop production runs. Open <http://localhost:4300> for the inspector.

`kapso-emulator --help` lists every flag; each one also reads a `KAPSO_EMULATOR_*` environment variable.

## In a test suite

```bash
npm i -D kapso-emulator
```

```ts
import { createKapsoEmulator } from "kapso-emulator";

// With no `port`, each emulator binds its own free port — safe to boot one
// per test file in parallel; `emulator.url` is the resolved address.
const emulator = await createKapsoEmulator({
  webhook: { url: `${appUrl}/webhooks/kapso`, secret: "test-secret" },
  echo_delay_ms: 0, // echo sends back immediately
});
// Point your app at emulator.url instead of api.kapso.ai / app.kapso.ai,
// drive it through fetch or /_kapso/simulate/*, then:
emulator.reset(); // wipe state between tests; webhook wiring survives
await emulator.close();
```

## Failure injection

```bash
# Fail the next send with Meta's "Message undeliverable" (131026)
curl -X POST http://localhost:4300/_kapso/simulate/failures \
  -H 'Content-Type: application/json' -d '{"send": {"times": 1}}'
```

Three rules, all optional — `POST` replaces the set, `GET` reads it, `DELETE` (or `/_kapso/simulate/reset`) clears it:

| Rule | Effect |
|---|---|
| `send` | Sends fail with a Graph error. Scope with `to`, limit with `times`, override `error: {code, message, http_status}`. |
| `template_review` | `{"status": "REJECTED", "reason": "..."}` — template creates are rejected instead of instantly approved. |
| `broadcast` | `{"phones": [...]}` — those recipients fail during broadcast fan-out with `error_message`. |

## How it works

![Route groups for the Meta proxy, Platform API, and simulator share an in-memory store; a dispatcher signs and delivers webhooks; anything not emulated hits a catch-all 501.](https://raw.githubusercontent.com/silicon-intern/kapso-emulator/main/docs/images/detailed-architecture.png)

Emulated: message sends of every common type (text, template, interactive, media), read receipts and typing, media upload/download with Meta's real MIME validation, WABA templates, Platform phone numbers, conversation message listing, and the full broadcasts flow. Everything else 501s loudly — contributions welcome.

Both webhook events POST to the configured target with `X-Webhook-Event` (`whatsapp.message.received` or `whatsapp.message.sent`) and `X-Webhook-Signature` — hex HMAC-SHA256 of the raw body with your secret. Sent echoes carry `message.kapso.origin: "cloud_api"`; `POST /_kapso/simulate/business-app-message` simulates the owner replying from the WhatsApp Business App (`origin: "business_app"`).

The complete route reference — every route with request bodies, the signing contract, id formats, and behavioral guarantees — lives in [AGENTS.md](AGENTS.md), which ships in the npm package so an AI agent in your repo can read it at `node_modules/kapso-emulator/AGENTS.md`.

## Notes

- Node >= 20, ESM-only — `import` it or run the CLI; no CommonJS `require()`.
- State lives in memory; pass `--state-file <path>` to persist and restore across restarts.
- Unofficial project, not affiliated with Kapso or Meta. Wire shapes track observed production behavior — if something drifts, please open an issue.

## License

Apache-2.0
