// The wording for "when did this damage appear?" (DEC-42). Damage reported in a PRE-shift inspection that was not already in the
// register appeared between the vehicle's previous post-shift inspection and that pre-shift inspection. It is a pointer for
// investigation. It never says or implies who is at fault; the wording is fixed here so the page cannot drift into blame.
export type DamageInterval = {
  previous_allocation_id: string | null;
  previous_allocation_planned_start_at: string | null;
  previous_allocation_planned_end_at: string | null;
  previous_post_shift_submitted_at: string | null;
} | null;

const when = (iso: string) =>
  new Intl.DateTimeFormat("en-ZA", {
    timeZone: "Africa/Johannesburg",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));

/** A short, stable reference for an allocation (the first 8 characters of its id). */
export const allocationRef = (id: string) => id.slice(0, 8).toUpperCase();

export function intervalText(i: DamageInterval): string | null {
  if (!i) return null; // post-shift reports have no interval
  if (!i.previous_allocation_id) return "No previous post-shift inspection.";
  const ref = allocationRef(i.previous_allocation_id);
  if (i.previous_post_shift_submitted_at) {
    return `Appeared after the post-shift inspection of ${when(i.previous_post_shift_submitted_at)} on allocation ${ref}.`;
  }
  return `The vehicle's previous allocation was ${ref}${
    i.previous_allocation_planned_start_at
      ? ` (planned ${when(i.previous_allocation_planned_start_at)})`
      : ""
  }; it has no submitted post-shift inspection.`;
}

export const NO_FAULT_NOTE =
  "This records when the damage was first reported. It does not say who caused it.";
