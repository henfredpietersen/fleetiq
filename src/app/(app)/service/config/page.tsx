import { randomUUID } from "node:crypto";
import { Suspense } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AppShell, Loading } from "@/components/app-shell";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { formatDateTime } from "@/modules/fleet-vehicles/domain/format";
import { requireSession } from "@/modules/identity-access/server/session";
import {
  SERVICE_SCOPE_LABELS,
  type ServiceScope,
} from "@/modules/service-monitoring/domain/service-config";
import { formatKm } from "@/modules/service-monitoring/domain/format";
import {
  hasPermission,
  listConfigs,
  listOverrideRequests,
  listVehicleOptions,
} from "@/modules/service-monitoring/server/queries";
import {
  ChangeDefaultForm,
  DecideOverrideForm,
  RequestOverrideForm,
} from "@/modules/service-monitoring/ui/config-forms";
import { ServiceNav } from "@/modules/service-monitoring/ui/service-nav";

const STATUS_BADGE: Record<
  string,
  "warning" | "success" | "destructive" | "outline"
> = {
  pending: "warning",
  approved: "success",
  rejected: "destructive",
  cancelled: "outline",
};

async function Content() {
  const ctx = await requireSession("full");
  const db = await createSupabaseServerClient();
  const [cfgRes, reqRes, vehRes, canManage] = await Promise.all([
    listConfigs(db),
    listOverrideRequests(db, ctx.userId),
    listVehicleOptions(db),
    hasPermission(db, "service.config.manage", null),
  ]);
  if (!cfgRes.ok)
    return (
      <Alert variant="destructive">
        The service configuration could not be loaded. Please refresh the page.
      </Alert>
    );

  const vehicles = vehRes.ok ? vehRes.vehicles : [];
  const vehicleLabel = new Map(vehicles.map((v) => [v.id, v.label]));
  const target = (c: (typeof cfgRes.configs)[number]) =>
    c.scope === "vehicle"
      ? (vehicleLabel.get(c.vehicle_id ?? "") ?? "Vehicle")
      : c.scope === "make_model"
        ? `${c.make} ${c.model}`
        : c.scope === "category"
          ? (c.vehicle_category ?? "—")
          : "All vehicles";
  const open = cfgRes.configs.filter((c) => c.effective_to === null);
  const history = cfgRes.configs.filter((c) => c.effective_to !== null);
  const company = open.find((c) => c.scope === "company_default");
  const requests = reqRes.ok ? reqRes.requests : [];

  const days = (c: (typeof open)[number]) =>
    c.service_interval_days === null
      ? "—"
      : `${c.service_interval_days} d (−${c.early_tolerance_days} / +${c.late_tolerance_days})`;
  const table = (rows: typeof open, closed: boolean) => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Applies to</TableHead>
          <TableHead>Interval</TableHead>
          <TableHead>Early / late</TableHead>
          <TableHead>Time basis</TableHead>
          <TableHead>{closed ? "Effective" : "Since"}</TableHead>
          <TableHead>Reason</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((c) => (
          <TableRow key={c.id}>
            <TableCell>
              <Badge variant="outline">
                {SERVICE_SCOPE_LABELS[c.scope as ServiceScope]}
              </Badge>{" "}
              {target(c)}
            </TableCell>
            <TableCell>{formatKm(c.service_interval_km)}</TableCell>
            <TableCell>
              −{formatKm(c.early_tolerance_km)} / +
              {formatKm(c.late_tolerance_km)}
            </TableCell>
            <TableCell>{days(c)}</TableCell>
            <TableCell>
              {closed
                ? `${formatDateTime(c.effective_from)} → ${formatDateTime(c.effective_to)}`
                : formatDateTime(c.effective_from)}
            </TableCell>
            <TableCell>{c.reason}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>In effect now</CardTitle>
          <CardDescription>
            Precedence: vehicle → make and model → category → company default
            (DEC-19). Changes are effective-dated; nothing is edited in place.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {open.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No configuration is visible to you.
            </p>
          ) : (
            table(open, false)
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Company default</CardTitle>
          <CardDescription>
            The fallback for every vehicle without a more specific
            configuration.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canManage && company ? (
            <ChangeDefaultForm
              current={{
                serviceIntervalKm: company.service_interval_km,
                earlyToleranceKm: company.early_tolerance_km,
                lateToleranceKm: company.late_tolerance_km,
                serviceIntervalDays: company.service_interval_days,
                earlyToleranceDays: company.early_tolerance_days,
                lateToleranceDays: company.late_tolerance_days,
              }}
            />
          ) : (
            <p className="text-muted-foreground text-sm">
              Only a service configuration manager can change the company
              default.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Overrides</CardTitle>
          <CardDescription>
            A vehicle, make and model, or category override needs a reason and
            must be approved by a different service configuration manager before
            it takes effect (DEC-24).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {canManage ? (
            <RequestOverrideForm
              vehicles={vehicles}
              submissionId={randomUUID()}
            />
          ) : (
            <p className="text-muted-foreground text-sm">
              Only a service configuration manager can request an override.
            </p>
          )}
          <div>
            <h2 className="mb-2 text-sm font-semibold">Requests</h2>
            {!reqRes.ok ? (
              <Alert variant="destructive">
                The override requests could not be loaded.
              </Alert>
            ) : requests.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No override requests yet.
              </p>
            ) : (
              <ul
                className="flex flex-col gap-4"
                aria-label="Override requests"
              >
                {requests.map((r) => {
                  const p = r.payload as Record<string, string | number | null>;
                  return (
                    <li key={r.id} className="rounded-md border p-4">
                      <div className="flex flex-wrap items-center gap-3">
                        <Badge variant={STATUS_BADGE[r.status] ?? "outline"}>
                          {r.status === "pending"
                            ? "Awaiting approval"
                            : r.status}
                        </Badge>
                        <span className="font-medium">
                          {SERVICE_SCOPE_LABELS[p.scope as ServiceScope] ??
                            p.scope}
                          :{" "}
                          {p.scope === "vehicle"
                            ? (vehicleLabel.get(String(p.vehicle_id)) ??
                              "vehicle")
                            : p.scope === "make_model"
                              ? `${p.make} ${p.model}`
                              : String(p.vehicle_category ?? "")}
                        </span>
                        <span className="text-muted-foreground text-sm">
                          {formatKm(Number(p.service_interval_km))} · −
                          {formatKm(Number(p.early_tolerance_km))} / +
                          {formatKm(Number(p.late_tolerance_km))}
                          {p.service_interval_days
                            ? ` · ${p.service_interval_days} d`
                            : ""}
                        </span>
                      </div>
                      <p className="mt-2 text-sm">
                        <span className="text-muted-foreground">Reason: </span>
                        {r.reason}
                        {r.requestedByMe ? " (requested by you)" : ""}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        Requested {formatDateTime(r.createdAt)}
                        {r.decidedAt
                          ? ` · decided ${formatDateTime(r.decidedAt)}`
                          : ""}
                        {r.decisionNotes ? ` · ${r.decisionNotes}` : ""}
                      </p>
                      {r.status === "pending" ? (
                        r.requestedByMe ? (
                          <p className="text-muted-foreground mt-3 text-sm">
                            You cannot approve your own request. A different
                            service configuration manager must decide it.
                          </p>
                        ) : canManage ? (
                          <div className="mt-3">
                            <DecideOverrideForm approvalId={r.id} />
                          </div>
                        ) : null
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      {history.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>History</CardTitle>
            <CardDescription>
              Closed configurations are kept for audit and never change.
            </CardDescription>
          </CardHeader>
          <CardContent>{table(history, true)}</CardContent>
        </Card>
      ) : null}
    </>
  );
}

export default function ServiceConfigPage() {
  return (
    <AppShell
      title="Service configuration"
      description="Intervals and tolerances (PRD §5.10.5; DEC-19)."
    >
      <ServiceNav />
      <Suspense fallback={<Loading label="Loading configuration…" />}>
        <Content />
      </Suspense>
    </AppShell>
  );
}
