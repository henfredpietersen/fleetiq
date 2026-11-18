// Shapes returned by the lifecycle server code, shared with client components (no server imports here).
export type MyAllocation = {
  id: string;
  status: string;
  plannedStartAt: string;
  plannedEndAt: string;
  shiftDate: string;
  shiftStartAt: string;
  shiftEndAt: string;
  fleetNumber: string;
  registration: string;
  make: string;
  model: string;
  branchName: string;
  licenceClassCheck: string;
  canOpen: boolean;
  openedOnBehalf: boolean;
};

export type HistoryEvent = {
  id: string;
  eventType: string;
  occurredAt: string;
  actorName: string;
  reason: string | null;
  previous: Record<string, unknown> | null;
  next: Record<string, unknown> | null;
  onBehalf: boolean;
};
