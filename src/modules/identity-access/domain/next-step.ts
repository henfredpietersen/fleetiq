// Where a signed-in user must go next. Pure so it can be tested exhaustively; the same ordering is
// enforced server-side by requireSession() and, underneath, by has_permission()/RLS.

export type SessionFacts = {
  mustChangePin: boolean;
  requiresMfa: boolean;
  aal: "aal1" | "aal2";
};

export type NextStep = "/change-pin" | "/mfa" | "/home";

export function nextAuthStep(f: SessionFacts): NextStep {
  if (f.mustChangePin) return "/change-pin";
  if (f.requiresMfa && f.aal !== "aal2") return "/mfa";
  return "/home";
}
