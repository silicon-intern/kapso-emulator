# kapso-emulator — agent reference

A local, stateful emulator of the Kapso WhatsApp platform: the Meta Graph
proxy (`api.kapso.ai/meta/whatsapp`), the Platform API
(`app.kapso.ai/platform/v1`), signed `whatsapp.message.*` webhooks with
sent-message echoes, a simulator surface for injecting inbound customer
messages, failure injection, and an HTML inspector. Never deploy it; it is a
development and test double.

## Start

```bash
npx kapso-emulator --webhook-url <your-webhook-endpoint> --webhook-secret <secret>
# or embedded:
#   import { createKapsoEmulator } from "kapso-emulator";
#   const emulator = await createKapsoEmulator({ webhook: { url, secret }, echo_delay_ms: 0 });
```

Every CLI flag has a `KAPSO_EMULATOR_*` env var twin (`--help` lists them).
Default port 4300; `--port 0` picks a free one and prints it as
`KAPSO_EMULATOR_LISTENING <url>`.

## URL mapping

| Production Kapso URL | Emulator URL |
|---|---|
| `https://api.kapso.ai/meta/whatsapp/v23.0/...` | `<emulator>/meta/whatsapp/v23.0/...` |
| `https://app.kapso.ai/platform/v1/...` | `<emulator>/platform/v1/...` |

Auth: every Meta-proxy and Platform route requires `X-API-Key`. Missing key
is a 401. If the emulator was started with `--api-key`, the key must match;
otherwise any non-empty key passes. Simulator routes (`/_kapso/simulate/*`),
the inspector (`GET /`), and media blob downloads are unauthenticated.

## Webhook contract

Two events POST to the configured target, both signed:

- Headers: `X-Webhook-Event` (`whatsapp.message.received` |
  `whatsapp.message.sent`), `X-Webhook-Signature` (hex HMAC-SHA256 of the
  raw body with the shared secret), `Content-Type: application/json`.
- Body shape: `{ message: { id, timestamp, type, kapso: { direction,
  origin?, whatsapp_conversation_id, content, contact_name?, media_url?,
  media_data? }, <media-kind>?, referral? }, conversation: { id,
  phone_number, phone_number_id, contact_name? }, phone_number_id }`.
- Every accepted outbound send echoes back as `whatsapp.message.sent` after
  `echo_delay_ms` (default 300ms) with `kapso.origin: "cloud_api"`.
  Business-app simulation echoes carry `origin: "business_app"` — consumers
  usually read that as a human takeover.
- Template content split, matching real Kapso: the webhook echo of an
  ordinary template send carries the `[plantilla: <name>]` marker as
  `content`; the Platform message listing returns the RENDERED body; a
  BROADCAST fan-out echo also carries the RENDERED body.

## Meta proxy routes

| Route | Behavior |
|---|---|
| `POST /meta/whatsapp/:v/:phoneNumberId/messages` | Sends: text, template, interactive, image, audio, video, document, sticker. Also accepts `{ "status": "read" }` (read receipt / typing indicator; no message created). Unsupported types 501. Responds `{ messages: [{ id: <wamid> }] }`. |
| — media send rule | A media send referencing a media id the emulator never minted gets Meta's Graph error 100 (`Param <type>.id is not a valid whatsapp business account media attachment ID`). Upload first. |
| `POST /meta/whatsapp/:v/:phoneNumberId/media` | Multipart upload; the file PART's content type is validated against Meta's allowed list (the `type` form field does not override it); violations get Meta's `(#100)` error. Responds `{ id }`. |
| `GET /meta/whatsapp/:v/:mediaId` | Media metadata with `url`/`download_url` pointing at `<emulator>/media-files/:id` (unauthenticated blob, like a CDN URL). |
| `DELETE /meta/whatsapp/:v/:mediaId` | Delete. |
| `POST /meta/whatsapp/:v/:wabaId/message_templates` | Create; review is INSTANT (`status: "APPROVED"`) unless a `template_review` failure rule is active (then REJECTED with `rejected_reason`). Re-submitting an existing name+language re-reviews with the new content instead of erroring as duplicate. |
| `GET /meta/whatsapp/:v/:wabaId/message_templates?name=&language=` | Listing, `{ data: [...] }`. |
| `GET /meta/whatsapp/:v/:wabaId/message_templates/:templateId` | Read by id; unknown or foreign-WABA id gets Meta's own GraphMethodException 404, never a 501. |

## Platform API routes

Platform responses are enveloped `{ data, meta? }`; Meta-proxy responses are
bare, like Meta's own.

| Route | Behavior |
|---|---|
| `GET /platform/v1/whatsapp/phone_numbers/:id` | One connected number. Registered on FIRST lookup (there is no provisioning surface); `whatsapp_business_account_id` is derived from the number id (`waba-<id>`), stable across restarts — resolve the WABA here, then create templates under it. |
| `GET /platform/v1/whatsapp/messages?conversation_id=&phone_number_id=&direction=&limit=` | Conversation listing, newest first. Rows carry `timestamp`, `content` (rendered for templates), and `kapso.message_type_data` (template name + BODY params) for rehydration. |
| `POST /platform/v1/whatsapp/broadcasts` | Create; requires a REGISTERED template id (unknown id is a loud 404, never a fake send). Body: `{ whatsapp_broadcast: { name, phone_number_id, whatsapp_template_id } }`. |
| `POST .../broadcasts/:id/recipients` | Draft-only; per-broadcast phone dedupe; responds `{ data: { added, duplicates, errors } }`. |
| `POST .../broadcasts/:id/send` | Fans out one real outbound template message per pending recipient (echoing `whatsapp.message.sent` with the RENDERED body); recipients advance to sent + delivered, then `responded` when the simulated customer replies. Recipients matching a `broadcast` failure rule become `failed` instead. |
| `GET .../broadcasts/:id` | Funnel-cumulative counters recomputed from recipient rows. |
| `GET .../broadcasts/:id/recipients?page=&per_page=` | Paged; server caps `per_page` at 50 (below the common client 100) so multi-page paths get exercised; `meta.total_pages` is the stop authority. |

## Simulator routes

| Route | Purpose |
|---|---|
| `POST /_kapso/simulate/inbound-message` | Inject a customer message; delivers the signed `whatsapp.message.received`. Body: `{ phone_number_id, from, text?, type?, contact_name?, media? { content_type, data_base64, filename?, caption? }, referral? }`. `referral` passes through verbatim as `message.referral` (Meta CTWA shape). |
| `POST /_kapso/simulate/business-app-message` | Owner reply from the WhatsApp Business App: a sent echo with `origin: business_app`. Body: `{ phone_number_id, from, text }`. |
| `POST /_kapso/simulate/rotate-conversation` | Retire the active Kapso conversation id, mint a fresh one. Thread identity is `(phone_number_id, customer_phone)`; the Kapso id is transport, as in production. |
| `POST /_kapso/simulate/reset` | Wipe all state (including failure rules); webhook wiring survives. |
| `GET /_kapso/simulate/events?after=<seq>` | Cursor-polled ephemeral feed: typing, read receipts, send log, failure events. |
| `GET /_kapso/simulate/thread?phone_number_id=&from=` | The emulator's own view of one thread. |
| `GET`/`POST`/`DELETE /_kapso/simulate/failures` | Failure injection, below. |
| `GET /` | Inspector: messages, webhook deliveries, conversations. |

## Failure injection

`POST /_kapso/simulate/failures` replaces the whole rule set (`GET` reads,
`DELETE` clears, reset clears). All rules optional:

```jsonc
{
  "send": {
    "to": "59171234567",   // optional: only sends to this phone (digits compared)
    "times": 1,             // optional: rule clears itself after N matches
    "error": { "code": 131026, "message": "Message undeliverable", "http_status": 400 }
  },
  "template_review": { "status": "REJECTED", "reason": "INVALID_FORMAT" },
  "broadcast": { "phones": ["59171234567"], "error_message": "Message undeliverable" }
}
```

A failed send returns a Graph-shaped error, records a `send_failed` event,
and leaves NO message row and NO echo. A rejected template shows
`status: "REJECTED"` on create, the listing, and the by-id read; clear the
rule and resubmit the same name to get it re-approved.

## Behavioral guarantees

- **Unemulated surface = loud 501** with `error: "not_implemented"` plus the
  method and path. The emulator never fakes success for something it does
  not implement; treat a 501 as "add the route or avoid the call".
- **Ids are unique across emulator restarts** (`wamid.emu.<boot>.<n>`),
  so consumers deduping webhooks by wamid never see a restarted emulator's
  messages as duplicates.
- **State is in memory**; with `--state-file` the store snapshots to JSON
  every 2s and restores on boot (stored media URLs stay resolvable).
- **Phones are normalized to digits** everywhere in the store.

## Working on this repo

Layout: `src/index.ts` (plugin + exports), `src/server.ts`
(`createKapsoEmulator`), `src/cli.ts`, `src/routes/{messages,media,platform,
simulator,inspector}.ts`, `src/{entities,store,helpers,formatters,ids,
failures}.ts`, tests in `test/`.

Commands: `npm test` (vitest), `npm run type-check`, `npm run lint` (Biome),
`npm run build` (tsup), `npm run dev` (boot from source).

Rules for changes:

- New Meta-proxy or Platform routes call `requireApiKey` first, and Platform
  success bodies are enveloped `{ data, meta? }` (consumer clients commonly
  throw on a payload without `data`).
- Never soften a verbatim Meta error (media id rejection, upload MIME
  `(#100)`, template 404): the strictness is what makes consumer recovery
  paths testable.
- Never replace the loud 501 fallbacks with silent successes.
- Keep ids boot-discriminated; a counter restarting at 1 turns every
  post-restart message into a silent duplicate for wamid-deduping consumers.
- Wire shapes mirror observed Kapso production behavior. If real Kapso
  drifts, change the emulator to match reality and say so in the PR.
