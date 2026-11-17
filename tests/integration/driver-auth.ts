import { DEFAULT_AUTH_CONFIG } from "@/modules/identity-access/domain/auth-config";
import { SupabaseDriverAuth } from "@/modules/identity-access/server/supabase-driver-auth";
import { admin, anonClient, SECRET, type Db, type World } from "./helpers";

export function driverAuthFor(w: World, userClient: Db = anonClient()) {
  return new SupabaseDriverAuth({
    admin: admin(),
    userClient,
    config: DEFAULT_AUTH_CONFIG,
    secret: SECRET,
    companyId: w.companyId,
  });
}
