"use server";
// Server actions for the allocation lifecycle: the only entry points the UI uses. Each re-checks the session (including
// MFA for staff, DEC-34) and runs as the signed-in user, so RLS and the SQL functions authorise. The service-role key is
// never used here. Idempotent: the client sends the same clientSubmissionId on every retry.
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/modules/identity-access/server/session";
import type { MyAllocation, HistoryEvent } from "../domain/lifecycle-types";
import * as service from "./lifecycle-service";

export type LifecycleReply =
  { ok: true; message: string } | { ok: false; message: string };

async function db() {
  await requireSession("full");
  return createSupabaseServerClient();
}

export async function transitionAction(input: {
  allocationId: string;
  toStatus: "pre_inspection_pending" | "cancelled" | "no_show";
  reason?: string;
  clientSubmissionId: string;
}): Promise<LifecycleReply> {
  const r = await service.transitionAllocation(await db(), input);
  if (!r.ok) return { ok: false, message: r.message };
  revalidatePath("/shifts/allocations");
  revalidatePath("/my-allocations");
  return {
    ok: true,
    message:
      input.toStatus === "pre_inspection_pending"
        ? "Allocation started."
        : input.toStatus === "cancelled"
          ? "Allocation cancelled."
          : "Marked as a no-show.",
  };
}

export async function amendTimesAction(input: {
  allocationId: string;
  plannedStartAt: string;
  plannedEndAt: string;
  reason: string;
  clientSubmissionId: string;
}): Promise<LifecycleReply> {
  const r = await service.amendAllocationTimes(await db(), input);
  if (!r.ok) return { ok: false, message: r.message };
  revalidatePath("/shifts/allocations");
  return { ok: true, message: "Planned times updated." };
}

export async function myAllocationsAction(range: {
  from: string;
  to: string;
}): Promise<
  { ok: true; allocations: MyAllocation[] } | { ok: false; message: string }
> {
  const r = await service.listMyAllocations(await db(), range);
  return r.ok
    ? { ok: true, allocations: r.allocations }
    : { ok: false, message: r.message };
}

export async function historyAction(
  allocationId: string,
): Promise<
  { ok: true; events: HistoryEvent[] } | { ok: false; message: string }
> {
  const r = await service.getAllocationHistory(await db(), allocationId);
  return r.ok
    ? { ok: true, events: r.events }
    : { ok: false, message: r.message };
}

export async function checkAmendAction(input: {
  allocationId: string;
  plannedStartAt: string;
  plannedEndAt: string;
}): Promise<
  | { ok: true; eligible: boolean; problems: string[] }
  | { ok: false; message: string }
> {
  const r = await service.checkAmend(await db(), input);
  return r.ok
    ? { ok: true, eligible: r.eligible, problems: r.problems }
    : { ok: false, message: r.message };
}
