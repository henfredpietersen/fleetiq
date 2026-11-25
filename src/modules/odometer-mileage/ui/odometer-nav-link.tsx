import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { reviewBranches, reviewCounts } from "../server/review-service";

/**
 * "Odometer review" in the Shifts navigation, with the open count as a badge. Rendered only for people who hold
 * odometer.exception.review for at least one branch (has_permission, per branch). A convenience only: the page, the actions, the SQL functions and RLS enforce the same rule.
 */
export async function OdometerReviewLink() {
  let total: number | null = null;
  try {
    const db = await createSupabaseServerClient();
    const b = await reviewBranches(db);
    if (!b.ok || b.branches.length === 0) return null;
    const r = await reviewCounts(db);
    if (r.ok) total = r.quickCheck + r.fullReview;
  } catch {
    total = null; // never break the page frame because the badge failed
  }
  return (
    <Link
      href="/odometer/review"
      className="flex items-center gap-2 text-sm font-medium hover:underline"
    >
      Odometer review
      {total !== null && total > 0 ? (
        <span
          data-testid="odometer-review-badge"
          className="bg-destructive text-destructive-foreground rounded-full px-2 py-0.5 text-xs"
          aria-label={`${total} readings waiting for review`}
        >
          {total}
        </span>
      ) : null}
    </Link>
  );
}
