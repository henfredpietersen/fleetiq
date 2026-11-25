import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { listOverdue } from "../server/conflict-service";

/** "Missing / Late" in the Shifts navigation, with the live count (overdue inspections + open sync conflicts) as a badge. */
export async function MissingLateLink() {
  let count: number | null = null;
  try {
    const r = await listOverdue(await createSupabaseServerClient());
    if (r.ok) count = r.rows.length;
  } catch {
    count = null; // never break the page frame because the badge failed
  }
  return (
    <Link
      href="/shifts/missing"
      className="flex items-center gap-2 text-sm font-medium hover:underline"
    >
      Missing / Late
      {count !== null && count > 0 ? (
        <span
          data-testid="missing-late-badge"
          className="bg-destructive text-destructive-foreground rounded-full px-2 py-0.5 text-xs"
          aria-label={`${count} missing or late`}
        >
          {count}
        </span>
      ) : null}
    </Link>
  );
}
