# Changelog

## 0.1.0

Initial release.

- Meta Graph proxy: message sends (text, template, interactive, image, audio,
  video, document, sticker), read receipts and typing, media upload/metadata/
  download/delete with Meta's real MIME validation, WABA template create/list/
  read-by-id with instant approval.
- Platform API: phone numbers, conversation message listing, and the full
  broadcasts flow (create, recipients, send, counters, paged listing).
- Signed webhook loopback: `whatsapp.message.received` on injected inbound,
  `whatsapp.message.sent` echo for every accepted send (HMAC-SHA256).
- Simulator surface: inbound injection (text, media, CTWA referral),
  business-app takeover, conversation rotation, reset, event feed, thread
  view, HTML inspector.
- Failure injection: send refusals with Graph errors, template review
  rejection, broadcast recipient failures.
- `npx kapso-emulator` CLI with env-var twins for every flag, plus the
  embeddable `createKapsoEmulator()` for test suites.
