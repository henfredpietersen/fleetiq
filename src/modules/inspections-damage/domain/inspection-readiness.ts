// What still stands between the driver and Submit (PRD §5.7). ONE place in TypeScript, mirroring the checks inside the SQL
// function public.submit_inspection() (migrations 039/040/043/047), in the SAME ORDER and with the SAME messages and codes
// (IN001–IN007), which stays the final word: the database re-checks everything and its own refusal is shown as is.
// Submit is enabled only when this list is empty, so the button never promises something the server would refuse.
import type { ResponseType } from "./inspection-rules";

export type ReadinessItem = {
  id: string;
  question: string;
  responseType: ResponseType;
  required: boolean;
  sequence: number;
};
export type ReadinessAnswer = { value?: string; comment?: string };
export type ReadinessInput = {
  vehicleConfirmed: boolean;
  /** DEC-42: the person completing the inspection confirmed they checked the vehicle's known damage list. */
  knownDamageReviewed: boolean;
  registration: string;
  /** Items for this stage, in checklist order. */
  items: ReadinessItem[];
  answers: Record<string, ReadinessAnswer | undefined>;
  /** Template item ids that already have at least one attached photo. */
  itemsWithPhoto: ReadonlySet<string>;
  /** A current odometer photo is attached. */
  odometerPhoto: boolean;
};
export type Blocker = {
  code: "IN001" | "IN002" | "IN003" | "IN004" | "IN005" | "IN006" | "IN007";
  message: string;
  /** Checklist item the blocker is about (not set for the vehicle and odometer blockers). */
  itemId?: string;
};

const blank = (c: string | undefined) => !c || c.trim() === "";

/** Every blocker, in the order the server checks them (the server stops at the first). */
export function submitBlockers(i: ReadinessInput): Blocker[] {
  const out: Blocker[] = [];
  const items = [...i.items].sort((a, b) => a.sequence - b.sequence);
  if (!i.vehicleConfirmed) {
    out.push({
      code: "IN001",
      message: `Confirm that you are inspecting the vehicle shown (${i.registration}) before you submit.`,
    });
  }
  if (!i.knownDamageReviewed) {
    out.push({
      code: "IN007",
      message:
        "Confirm that you checked the vehicle's known damage list before you submit.",
    });
  }
  const unanswered = items.filter(
    (it) => it.required && !i.answers[it.id]?.value,
  );
  if (unanswered.length > 0) {
    out.push({
      code: "IN002",
      itemId: unanswered[0]!.id,
      message: `Answer every required item before you submit: "${unanswered[0]!.question}" is not answered (${unanswered.length} still to answer).`,
    });
  }
  for (const it of items) {
    const a = i.answers[it.id];
    if (
      it.responseType === "ok_defect" &&
      a?.value === "defect" &&
      blank(a.comment)
    ) {
      out.push({
        code: "IN003",
        itemId: it.id,
        message: `Describe the defect: "${it.question}" needs a comment.`,
      });
      break;
    }
  }
  for (const it of items) {
    const a = i.answers[it.id];
    if (
      it.responseType === "ok_defect" &&
      a?.value === "defect" &&
      !i.itemsWithPhoto.has(it.id)
    ) {
      out.push({
        code: "IN004",
        itemId: it.id,
        message: `Add a photo of the defect: "${it.question}" needs at least one photo.`,
      });
      break;
    }
  }
  for (const it of items) {
    const a = i.answers[it.id];
    if (
      it.responseType === "yes_no_detail" &&
      a?.value === "yes" &&
      blank(a.comment)
    ) {
      out.push({
        code: "IN005",
        itemId: it.id,
        message: `Add the details: "${it.question}" was answered Yes and needs a comment.`,
      });
      break;
    }
  }
  if (!i.odometerPhoto) {
    out.push({
      code: "IN006",
      message:
        "The odometer photo is required: take a photo of the odometer before you submit.",
    });
  }
  return out;
}

export const canSubmit = (i: ReadinessInput) => submitBlockers(i).length === 0;
