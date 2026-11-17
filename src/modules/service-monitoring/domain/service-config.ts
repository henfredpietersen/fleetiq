// Pure mirror of public.resolve_service_config (migration 022; DEC-19 precedence, effective-dated).
// vehicle -> make_model -> category -> company_default, the configuration effective at `at`.
// The database function is the authority; this exists so the rule can be tested and reused without a round trip,
// and the SAME cases are asserted here and in supabase/tests/database/phase2c_service_baseline.test.sql.

export const SERVICE_SCOPES = [
  "vehicle",
  "make_model",
  "category",
  "company_default",
] as const;
export type ServiceScope = (typeof SERVICE_SCOPES)[number];

export const SERVICE_SCOPE_LABELS: Record<ServiceScope, string> = {
  vehicle: "Vehicle",
  make_model: "Make and model",
  category: "Category",
  company_default: "Company default",
};

export type ServiceConfig = {
  id: string;
  scope: ServiceScope;
  vehicleId: string | null;
  make: string | null;
  model: string | null;
  vehicleCategory: string | null;
  serviceIntervalKm: number;
  earlyToleranceKm: number;
  lateToleranceKm: number;
  serviceIntervalDays: number | null;
  earlyToleranceDays: number | null;
  lateToleranceDays: number | null;
  /** ISO timestamp, inclusive. */
  effectiveFrom: string;
  /** ISO timestamp, exclusive; null = still open. */
  effectiveTo: string | null;
};

export type VehicleRef = {
  id: string;
  make: string;
  model: string;
  vehicleCategory: string;
};

export class NoServiceConfigError extends Error {
  constructor(vehicleId: string, at: Date) {
    super(
      `no service configuration applies to vehicle ${vehicleId} at ${at.toISOString()} (not even a company default)`,
    );
    this.name = "NoServiceConfigError";
  }
}

const PRECEDENCE: Record<ServiceScope, number> = {
  vehicle: 1,
  make_model: 2,
  category: 3,
  company_default: 4,
};

const eq = (a: string | null, b: string) =>
  a !== null && a.toLowerCase() === b.toLowerCase();

function effectiveAt(c: ServiceConfig, at: number): boolean {
  const from = Date.parse(c.effectiveFrom);
  const to = c.effectiveTo === null ? Infinity : Date.parse(c.effectiveTo);
  return from <= at && at < to; // [from, to)
}

function appliesTo(c: ServiceConfig, v: VehicleRef): boolean {
  switch (c.scope) {
    case "vehicle":
      return c.vehicleId === v.id;
    case "make_model":
      return eq(c.make, v.make) && eq(c.model, v.model);
    case "category":
      return eq(c.vehicleCategory, v.vehicleCategory);
    case "company_default":
      return true;
  }
}

/** Exactly one configuration, or NoServiceConfigError. */
export function resolveServiceConfig(
  vehicle: VehicleRef,
  configs: readonly ServiceConfig[],
  at: Date,
): ServiceConfig {
  if (Number.isNaN(at.getTime()))
    throw new RangeError("a valid time is required");
  const t = at.getTime();
  const best = configs
    .filter((c) => effectiveAt(c, t) && appliesTo(c, vehicle))
    .sort((a, b) => PRECEDENCE[a.scope] - PRECEDENCE[b.scope])[0];
  if (!best) throw new NoServiceConfigError(vehicle.id, at);
  return best;
}
