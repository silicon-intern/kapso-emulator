import { randomBytes } from "node:crypto";

// Ids are unique across emulator RESTARTS and across CONCURRENT emulators: a
// consuming API dedupes webhooks by wamid, so a counter that restarts at 1
// makes every post-restart message a silent "duplicate" of the first
// session's — and two test-suite emulators booted in the same millisecond
// would collide on a timestamp alone, so the discriminator carries a random
// suffix too. Counters are module-level, so emulators sharing one process
// already share one sequence.
const BOOT_ID = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;

let wamidCounter = 0;
let conversationCounter = 0;
let mediaCounter = 0;
let templateCounter = 0;
let broadcastCounter = 0;
let broadcastRecipientCounter = 0;

/** Real-shaped but visibly synthetic message id, unique across boots. */
export function kapsoWamid(): string {
  wamidCounter += 1;
  return `wamid.emu.${BOOT_ID}.${String(wamidCounter).padStart(4, "0")}`;
}

export function kapsoConversationId(): string {
  conversationCounter += 1;
  return `conv-emu-${BOOT_ID}-${String(conversationCounter).padStart(4, "0")}`;
}

export function kapsoMediaId(): string {
  mediaCounter += 1;
  return `media-emu-${BOOT_ID}-${String(mediaCounter).padStart(4, "0")}`;
}

export function kapsoTemplateId(): string {
  templateCounter += 1;
  return `tmpl-emu-${BOOT_ID}-${String(templateCounter).padStart(4, "0")}`;
}

export function kapsoBroadcastId(): string {
  broadcastCounter += 1;
  return `bc-emu-${BOOT_ID}-${String(broadcastCounter).padStart(4, "0")}`;
}

export function kapsoBroadcastRecipientId(): string {
  broadcastRecipientCounter += 1;
  return `bcr-emu-${BOOT_ID}-${String(broadcastRecipientCounter).padStart(4, "0")}`;
}
