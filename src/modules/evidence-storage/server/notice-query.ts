import "server-only";
import type { createSupabaseServerClient } from "@/lib/supabase/server";
import { CAMERA_NOTICE_VERSION } from "../domain/camera-notice";

/** Has this person acknowledged the CURRENT camera notice? Read on the server so the camera knows whether to ask. */
export async function cameraNoticeAcknowledged(
  db: Awaited<ReturnType<typeof createSupabaseServerClient>>,
): Promise<boolean> {
  const { data, error } = await db.rpc("camera_notice_acknowledged", {
    p_notice_version: CAMERA_NOTICE_VERSION,
  });
  return !error && data === true;
}
