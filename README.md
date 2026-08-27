# kapso-emulator

Local emulator for the [Kapso](https://kapso.ai) WhatsApp platform. It stands in for the two surfaces a Kapso app consumes — the Meta Graph proxy (`api.kapso.ai/meta/whatsapp`) and the Platform API (`app.kapso.ai/platform/v1`) — and loops every accepted send back to your app as a signed webhook. Your WhatsApp product runs end to end on localhost: no phone number, no Meta review wait, zero real messages.

- **Same wire shapes.** Sends, media, templates, broadcasts, and signed `whatsapp.message.*` webhooks match what Kapso emits in production — down to Meta's exact Graph errors for dead media handles and uploads whose file part isn't on Meta's allowed MIME list.
- **Instant template approval.** Real Meta review takes ~24h; the emulator approves at create so template flows run in a tight loop.
- **A simulator surface.** Inject customer messages (text, media, ad-click referrals), simulate the owner replying from the WhatsApp Business App, rotate conversation ids, poll typing and read events.
- **Failure injection.** Have it reject templates, refuse sends, or fail broadcast recipients — the errors you cannot provoke on demand against production.
- **Loud gaps.** Anything not emulated answers `501 not_implemented` with the method and path, never a fake success.

## Run

```bash
npx kapso-emulator \
  --webhook-url http://localhost:3000/webhooks/kapso \
  --webhook-secret your-webhook-secret
```

The default port is 4300 (`--port 0` picks a free one and prints it as `KAPSO_EMULATOR_LISTENING <url>`). Point your app's Kapso base URLs at it — any non-empty `X-API-Key` is accepted unless you pin one with `--api-key`:

| Production | Emulator |
|---|---|
| `https://api.kapso.ai/meta/whatsapp/v23.0/...` | `http://localhost:4300/meta/whatsapp/v23.0/...` |
| `https://app.kapso.ai/platform/v1/...` | `http://localhost:4300/platform/v1/...` |

Then have a customer write in. Use any `phone_number_id` you like — numbers spring into existence on first use, there is nothing to provision:

```bash
curl -X POST http://localhost:4300/_kapso/simulate/inbound-message \
  -H 'Content-Type: application/json' \
  -d '{"phone_number_id": "555111222333", "from": "59171234567", "text": "Hola!"}'
```

Your webhook target receives a signed `whatsapp.message.received`. Reply the way your app does — a normal Meta Graph send against the emulator's proxy path:

```bash
curl -X POST http://localhost:4300/meta/whatsapp/v23.0/555111222333/messages \
  -H 'Content-Type: application/json' -H 'X-API-Key: any-key' \
  -d '{"messaging_product": "whatsapp", "to": "59171234567", "type": "text", "text": {"body": "Hola! Si, tenemos lugar."}}'
```

The send is accepted with a `wamid` and echoes back ~300ms later as a signed `whatsapp.message.sent` — the same loop production runs. Open <http://localhost:4300> for the inspector (messages, webhook deliveries, conversations).

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

## Webhooks

Both events POST to the one configured target:

- `X-Webhook-Event`: `whatsapp.message.received` or `whatsapp.message.sent`
- `X-Webhook-Signature`: hex HMAC-SHA256 of the raw request body with your secret

Sent echoes carry `message.kapso.origin: "cloud_api"`. To simulate the business owner answering from their phone's WhatsApp Business App (which consumers usually treat as a human takeover), use `POST /_kapso/simulate/business-app-message` — that echo carries `origin: "business_app"`.

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
| `template_review` | `{"status": "REJECTED", "reason": "..."}` — template creates are rejected instead of instantly approved; resubmitting after clearing re-approves. |
| `broadcast` | `{"phones": [...]}` — those recipients fail during broadcast fan-out with `error_message`. |

## What's emulated

Message sends of every common type (text, template, interactive, image, audio, video, document, sticker) plus read receipts and typing; media upload, metadata, download, and delete with Meta's real MIME validation; WABA template create, list, and read-by-id; Platform phone numbers, conversation message listing, and the full broadcasts flow (create, recipients, send, counters, paged recipient listing). For templates and broadcasts, resolve the number's WABA id first — `GET /platform/v1/whatsapp/phone_numbers/<your-phone-number-id>` returns `whatsapp_business_account_id`, stable across restarts — and create templates under it. The complete route reference, request bodies included, lives in [AGENTS.md](AGENTS.md). Everything else 501s loudly — contributions welcome.

## For AI agents

[AGENTS.md](AGENTS.md) is a compact, machine-oriented reference: every route, the webhook signing contract, id formats, and the behavioral rules the emulator guarantees. It ships inside the npm package, so an agent working in your repo can read it at `node_modules/kapso-emulator/AGENTS.md`.

## Notes

- Node >= 20, ESM-only — `import` it (or run the CLI); CommonJS `require()` is not supported on Node 20/21.
- State lives in memory; pass `--state-file <path>` to persist and restore across restarts.
- Ids embed a per-boot discriminator, so consumers that dedupe webhooks by `wamid` never see a restarted emulator as duplicates.
- Unofficial project, not affiliated with Kapso or Meta. Wire shapes are tracked against observed production behavior; if something drifts, please open an issue.

## License

Apache-2.0
