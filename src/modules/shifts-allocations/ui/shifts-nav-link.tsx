import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getShiftAccess } from "../server/queries";

/**
 * Navigation entry for Shifts, rendered only for users who hold allocation.manage or reports.view for at least one
 * branch. A convenience only: the pages, server actions, SQL functions and RLS enforce the same rule.
 */
export async function ShiftsNavLink() {
  try {
    const db = await createSupabaseServerClient();
    const access = await getShiftAccess(db);
    if (!access.ok || !access.branches.some((b) => b.canView)) return null;
  } catch {
    return null; // never break the page frame because the navigation check failed
  }
  return (
    <Link href="/shifts" className="text-sm font-medium hover:underline">
      Shifts
    </Link>
  );
}
