import type { RouteContext } from "@emulators/core";
import { getKapsoStore } from "./../store.js";

/**
 * Unauthenticated blob serving, the emulator's stand-in for Meta/Kapso CDN
 * download URLs. Consumers fetch these with no auth header, exactly like the
 * short-lived URLs the media metadata endpoint hands out in production.
 */
export function mediaFileRoutes({ app, store }: RouteContext): void {
  app.get("/media-files/:mediaId", (c) => {
    const ks = getKapsoStore(store);
    const asset = ks.media.findOneBy("media_id", c.req.param("mediaId"));
    if (!asset) return c.json({ error: { message: "Media not found" } }, 404);
    const bytes = Buffer.from(asset.data_base64, "base64");
    return c.body(new Uint8Array(bytes).buffer, 200, {
      "Content-Type": asset.content_type,
      "Content-Length": String(bytes.byteLength),
      ...(asset.file_name
        ? { "Content-Disposition": `inline; filename="${asset.file_name.replace(/"/g, "")}"` }
        : {}),
    });
  });
}
