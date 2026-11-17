"use server";
// Server actions = the only entry points the UI uses. Each re-checks authentication and permission
// on the server (and again in RLS / SQL); the UI is never the security boundary.
import { createEvidenceDeps } from "./factory";
import { registerUpload } from "./register-upload";
import { requestUploadSlot } from "./request-upload";
import { issueSignedReadUrl, type ReadUrlRequest } from "./read-url";

export async function requestEvidenceUploadAction(input: unknown) {
  const { db, config } = await createEvidenceDeps();
  return requestUploadSlot({ db, config }, input);
}

export async function registerEvidenceUploadAction(input: { slotId: string }) {
  return registerUpload(await createEvidenceDeps(), { slotId: input?.slotId });
}

export async function getEvidenceReadUrlAction(input: ReadUrlRequest) {
  const { db, config } = await createEvidenceDeps();
  return issueSignedReadUrl({ db, config }, input);
}
