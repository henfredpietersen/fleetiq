// The offline queue's one endpoint (ARCH §6.9, DEC-06). Never cached (the service worker leaves /api alone), never redirects: a
// signed-out phone gets 401 and keeps its queue. All authorisation is in the database; this only checks that a full session exists.
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  getSessionContext,
  stepFor,
} from "@/modules/identity-access/server/session";
import { createEvidenceDeps } from "@/modules/evidence-storage/server/factory";
import { handleSync } from "@/modules/inspections-damage/offline/server/sync-handler";

const noStore = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, code: "22023", message: "Invalid request." },
      { status: 422, headers: noStore },
    );
  }
  const ctx = await getSessionContext();
  if (!ctx || ctx.profile.status !== "active" || stepFor(ctx) !== "/home")
    return NextResponse.json(
      { ok: false, code: "NO_SESSION", message: "Please sign in again." },
      { status: 401, headers: noStore },
    );
  const reply = await handleSync(
    {
      userId: ctx.userId,
      db: await createSupabaseServerClient(),
      evidence: () => createEvidenceDeps(),
    },
    input,
  );
  return NextResponse.json(reply.body, {
    status: reply.status,
    headers: noStore,
  });
}
