"use server";
// The supervisor's side of a sync conflict (DEC-43, DEC-24). Re-checks the session; the SQL function authorises (allocation.manage for
// the branch, a note, never your own report). Idempotent on clientSubmissionId.
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/modules/identity-access/server/session";
import { resolveSyncConflict } from "./conflict-service";

export async function resolveSyncConflictAction(
  input: unknown,
): Promise<{ ok: boolean; message: string }> {
  await requireSession("full");
  const r = await resolveSyncConflict(
    await createSupabaseServerClient(),
    input,
  );
  if (!r.ok) return { ok: false, message: r.message };
  revalidatePath("/shifts/missing");
  return {
    ok: true,
    message: "Resolved. The driver can now remove it from their phone.",
  };
}
