"use server";
// The first-use camera notice (PRD §6): who acknowledged which version, when (migration 044). Runs as the signed-in user.
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/modules/identity-access/server/session";
import { CAMERA_NOTICE_VERSION } from "../domain/camera-notice";

export async function acknowledgeCameraNoticeAction(): Promise<{
  ok: boolean;
}> {
  await requireSession("full");
  const db = await createSupabaseServerClient();
  const { error } = await db.rpc("acknowledge_camera_notice", {
    p_notice_version: CAMERA_NOTICE_VERSION,
  });
  return { ok: !error };
}
