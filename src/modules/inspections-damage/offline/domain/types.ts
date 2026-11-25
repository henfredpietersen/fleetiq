// What the phone stores (ARCH §6.9, AD-07). Every record carries the profile id of the signed-in person who created it: a queue
// is only ever read, shown or sent for that profile (DEC-43: never under another user's session).
export type Stage = "pre_shift" | "post_shift";
export type ItemKind =
  | "begin"
  | "save"
  | "confirm_known"
  | "photo"
  | "reading"
  | "report_damage"
  | "submit";

export type PhotoMeta = {
  blobId: string;
  size: number;
  width: number;
  height: number;
  /** The shutter time on the phone's clock: untrusted (ARCH §6.7). */
  capturedAt: string;
  location: {
    latitude: number;
    longitude: number;
    accuracyM?: number | null;
  } | null;
  capturedOffline: boolean;
};

export type SaveAnswer = {
  templateItemId: string;
  value: string;
  comment?: string;
};

export type PhotoTarget =
  { kind: "odometer" } | { kind: "defect"; templateItemId: string };

export type ItemPayload =
  | { kind: "begin" }
  | { kind: "save"; responses: SaveAnswer[]; vehicleConfirmed: boolean }
  | { kind: "confirm_known" }
  /** 5A (DEC-05, DEC-06): the driver's typed odometer reading, in whole km. Sent after the odometer photo, in the same order. */
  | { kind: "reading"; km: number }
  | {
      kind: "photo";
      target: PhotoTarget;
      photo: PhotoMeta;
      /** The attach step's own client_submission_id (the slot step uses the item's csid). */
      attachCsid: string;
      /** Set once the server has registered the file: a later retry skips straight to attach. */
      evidenceFileId?: string;
    }
  | {
      kind: "report_damage";
      zone: string;
      severity: string;
      description: string;
      photos: {
        photo: PhotoMeta;
        slotCsid: string;
        evidenceFileId?: string;
      }[];
    }
  | { kind: "submit" };

export type QueueItem = {
  id: string;
  profileId: string;
  /** Strictly increasing per phone: the order the driver acted in. */
  seq: number;
  /** `${allocationId}:${stage}` — items of one scope are sent strictly in order; a later item waits for the earlier one. */
  scope: string;
  allocationId: string;
  stage: Stage;
  kind: ItemKind;
  /** The item's own client_submission_id, created when the driver acted and reused on EVERY retry (DEC-06). */
  csid: string;
  /** Known when the draft already existed on the server; otherwise the result of the scope's `begin` is used. */
  inspectionId?: string;
  payload: ItemPayload;
  /** Phone clock when the driver acted: untrusted (DEC-06). */
  deviceTime: string;
  createdAt: number;
  capturedOffline: boolean;
  attempts: number;
  lastError?: string;
  nextAttemptAt: number;
};

/** A scope the server refused permanently. The items stay on the phone until a supervisor resolves it. */
export type ScopeState = {
  profileId: string;
  scope: string;
  allocationId: string;
  stage: Stage;
  status: "conflict" | "resolved";
  /** The refused item (its csid is the conflict's client_submission_id). */
  itemId: string;
  itemKind: ItemKind;
  conflictCsid: string;
  inspectionId?: string;
  code: string;
  message: string;
  deviceTime: string;
  detectedAt: number;
  reported: boolean;
  conflictId?: string;
  resolutionNote?: string;
  resolvedAt?: string;
};

export type Snapshot = {
  profileId: string;
  /** ISO server time when it was taken. */
  generatedAt: string;
  noticeAcknowledged: boolean;
  allocations: SnapshotAllocation[];
};
export type SnapshotAllocation = {
  allocation: {
    id: string;
    status: string;
    plannedStartAt: string;
    plannedEndAt: string;
    shiftStartAt: string;
    shiftEndAt: string;
    fleetNumber: string;
    registration: string;
    make: string;
    model: string;
    branchName: string;
    canOpen: boolean;
    openedOnBehalf: boolean;
    postShiftSubmitted: boolean;
  };
  /** The my_inspection document per stage (checklist version = the template items, known-damage list, current draft state). */
  inspections: Partial<Record<Stage, unknown>>;
};

export const scopeOf = (allocationId: string, stage: Stage) =>
  `${allocationId}:${stage}`;
