import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadEvidenceConfig } from "../domain/evidence-config";

/**
 * The one place the evidence module obtains clients (service-role isolation, ARCH §5.3):
 *  - `db` is the signed-in user's client: every query runs under RLS as that user.
 *  - `admin` is a LAZY factory so the request-slot and read-URL paths never construct the service-role
 *    client at all; only the reviewed registration step calls it.
 */
export async function createEvidenceDeps() {
  return {
    db: await createSupabaseServerClient(),
    admin: () => createAdminClient(),
    config: loadEvidenceConfig(),
  };
}
