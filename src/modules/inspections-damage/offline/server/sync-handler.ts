import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { EvidenceConfig } from "@/modules/evidence-storage/domain/evidence-config";
import type { Failure } from "@/modules/evidence-storage/domain/result";
import { registerUpload } from "@/modules/evidence-storage/server/register-upload";
import * as damage from "../../server/damage-service";
import * as service from "../../server/inspection-service";
import {
  requestInspectionDamageSlot,
  requestInspectionPhotoSlot,
} from "../../server/slot-service";
import { parseInput, syncEnvelope } from "../domain/sync-schema";
import * as conflicts from "./conflict-service";
import { buildSnapshot } from "./snapshot-service";

// The ONE server entry point of the offline queue (ARCH §6.9): POST /api/inspection-sync { op, profileId, ... }. Every op runs as the
// SIGNED-IN USER and calls the same services the forms always used, so the SQL functions authorise and re-check every rule. It
// never uses the service-role key itself (registration is the reviewed step inside registerUpload).
//
// HTTP status = how the phone classifies the answer (offline/domain/classify.ts):
//   200 ok · 401 sign in again (also: this work belongs to another profile) · 5xx / 408 / 429 retry later ·
//   403 / 404 / 409 / 410 / 422 the server REFUSED it on purpose: a conflict, shown with `code` and `message` as they are.
type Db = SupabaseClient<Database>;
export type SyncDeps = {
  userId: string;
  db: Db;
  evidence: () => Promise<{
    db: Db;
    admin: () => Db;
    config: EvidenceConfig;
  }>;
  now?: () => Date;
};
export type SyncReply = { status: number; body: Record<string, unknown> };

const RETRYABLE_CLASSES = ["08", "40", "53", "57", "58", "XX"];

/** HTTP status for a database refusal. No code and no validation details = our own "something went wrong": retry. */
export function statusForRefusal(code?: string, details?: string[]): number {
  if (!code) return details && details.length > 0 ? 422 : 503;
  if (code === "PGRST301") return 401;
  if (code.startsWith("PGRST")) return 503;
  if (RETRYABLE_CLASSES.some((c) => code.startsWith(c))) return 503;
  if (code === "42501") return 403;
  if (code === "P0002") return 404;
  if (code === "22023" || code === "22P02") return 409;
  return 409;
}

function refuse(r: {
  message: string;
  code?: string;
  details?: string[];
}): SyncReply {
  const status = statusForRefusal(r.code, r.details);
  return {
    status,
    body: {
      ok: false,
      code: r.code ?? (r.details?.length ? "22023" : "UNAVAILABLE"),
      message: r.details?.length
        ? `${r.message} ${r.details.join(" ")}`
        : r.message,
    },
  };
}

const EVIDENCE_STATUS: Record<Failure["code"], number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID_INPUT: 422,
  CONFLICT: 409,
  MIME_NOT_ALLOWED: 422,
  MIME_MISMATCH: 422,
  TOO_LARGE: 422,
  EMPTY_FILE: 422,
  INVALID_IMAGE: 422,
  OBJECT_MISSING: 503, // the upload has not arrived yet: try the upload again
  SLOT_EXPIRED: 410,
  SLOT_UNAVAILABLE: 409,
  UNAVAILABLE: 503,
};
const refuseEvidence = (f: Failure): SyncReply => ({
  status: EVIDENCE_STATUS[f.code],
  body: { ok: false, code: f.code, message: f.message },
});

const ok = (body: Record<string, unknown> = {}): SyncReply => ({
  status: 200,
  body: { ok: true, ...body },
});

export async function handleSync(
  deps: SyncDeps,
  input: unknown,
): Promise<SyncReply> {
  const env = parseInput(syncEnvelope, input);
  if (!env.ok)
    return {
      status: 422,
      body: { ok: false, code: "22023", message: "Invalid request." },
    };
  if (env.value.profileId !== deps.userId)
    return {
      status: 401,
      body: {
        ok: false,
        code: "WRONG_USER",
        message:
          "This work was saved under a different sign-in. Sign in as the person who saved it.",
      },
    };
  const body = (input ?? {}) as Record<string, unknown>;
  const { db } = deps;
  try {
    switch (env.value.op) {
      case "begin": {
        const r = await service.beginInspection(db, body);
        return r.ok ? ok({ inspectionId: r.inspectionId }) : refuse(r);
      }
      case "save": {
        const r = await service.saveResponses(db, body);
        return r.ok ? ok() : refuse(r);
      }
      case "confirm_known": {
        const r = await service.confirmKnownDamage(db, body);
        return r.ok ? ok() : refuse(r);
      }
      case "record_reading": {
        const r = await service.recordDriverReading(db, body);
        return r.ok ? ok() : refuse(r);
      }
      case "submit": {
        const r = await service.submitInspection(db, body);
        return r.ok
          ? ok({ lateFlag: r.lateFlag, safetyDefectFlag: r.safetyDefectFlag })
          : refuse(r);
      }
      case "attach_odometer": {
        const r = await service.attachOdometerPhoto(db, body);
        return r.ok ? ok() : refuse(r);
      }
      case "attach_defect": {
        const r = await service.attachDefectPhoto(db, body);
        return r.ok ? ok() : refuse(r);
      }
      case "report_damage": {
        const r = await damage.reportDamage(db, body);
        return r.ok ? ok({ damageId: r.damageId }) : refuse(r);
      }
      case "slot": {
        const ev = await deps.evidence();
        const r =
          body.kind === "damage"
            ? await requestInspectionDamageSlot(ev, body)
            : await requestInspectionPhotoSlot(ev, body);
        return r.ok ? ok({ slot: r.slot }) : refuseEvidence(r);
      }
      case "register": {
        const ev = await deps.evidence();
        const r = await registerUpload(ev, { slotId: body.slotId });
        return r.ok ? ok({ evidence: r.evidence }) : refuseEvidence(r);
      }
      case "report_conflict": {
        const r = await conflicts.reportSyncConflict(db, body);
        return r.ok ? ok({ conflictId: r.conflictId }) : refuse(r);
      }
      case "conflict_status": {
        const r = await conflicts.conflictStatus(db, body);
        return r.ok ? ok({ conflicts: r.conflicts }) : refuse(r);
      }
      case "snapshot": {
        const r = await buildSnapshot(
          db,
          deps.userId,
          deps.now ? deps.now() : new Date(),
        );
        return r.ok ? ok({ snapshot: r.snapshot }) : refuse(r);
      }
    }
  } catch {
    return {
      status: 503,
      body: {
        ok: false,
        code: "UNAVAILABLE",
        message: "Something went wrong on our side. Please try again.",
      },
    };
  }
}
