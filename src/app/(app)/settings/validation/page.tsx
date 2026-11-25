import { Suspense } from "react";
import { connection } from "next/server";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { requireSession } from "@/modules/identity-access/server/session";
import {
  formatLocalClock,
  formatShiftDate,
} from "@/modules/shifts-allocations/domain/format";
import { localDate } from "@/modules/shifts-allocations/domain/shift-times";
import { listSettings } from "@/modules/odometer-mileage/server/settings-service";
import { SettingsForm } from "@/modules/odometer-mileage/ui/settings-form";

const when = (iso: string) =>
  `${formatShiftDate(localDate(new Date(iso)))} ${formatLocalClock(iso)}`;
const show = (v: number | null, unit = "") =>
  v === null ? "not set" : `${v}${unit}`;

// Odometer validation settings (DEC-12 to DEC-18), settings.validation.manage with a company-wide grant. The current version of the company
// default (and of any category row) is shown with its history; saving closes it and starts the next version, with a reason.
async function Content() {
  await requireSession("full");
  await connection();
  const db = await createSupabaseServerClient();
  const r = await listSettings(db);
  if (!r.ok)
    return (
      <Alert variant="destructive" role="alert">
        The settings could not be loaded. {r.message}
      </Alert>
    );
  if (r.rows.length === 0)
    return (
      <Alert data-testid="settings-none">
        You do not have access to the validation settings. They are managed by
        someone with the company-wide settings permission.
      </Alert>
    );
  const current = r.rows.filter((x) => x.effective_to === null);
  return (
    <div className="flex flex-col gap-8">
      {current.map((c) => (
        <section
          key={c.id}
          className="flex flex-col gap-4 rounded-lg border p-4"
          aria-label={`Current settings: ${c.vehicle_category ?? "company default"}`}
          data-testid="current-settings"
        >
          <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
            {c.vehicle_category
              ? `Vehicle category: ${c.vehicle_category}`
              : "Company default"}
            <Badge variant="outline">Version {c.version}</Badge>
          </h2>
          <p className="text-muted-foreground text-sm">
            In effect since {when(c.effective_from)}
            {c.reason ? ` — ${c.reason}` : ""}
          </p>
          <SettingsForm
            categoryLabel={c.vehicle_category ?? "company default"}
            initial={{
              vehicleCategory: c.vehicle_category,
              maxKmPerAllocation: c.max_km_per_allocation,
              ocrMinConfidence: c.ocr_min_confidence,
              ocrDriverToleranceKm: c.ocr_driver_tolerance_km,
              unaccountedToleranceKm: c.unaccounted_tolerance_km,
              preShiftLateMinutes: c.pre_shift_late_minutes,
              postShiftLateMinutes: c.post_shift_late_minutes,
              staleReadingDays: c.stale_reading_days,
            }}
          />
        </section>
      ))}
      <section className="flex flex-col gap-3" aria-label="History">
        <h2 className="text-lg font-semibold">
          History ({r.rows.length} versions)
        </h2>
        <Table aria-label="Settings history">
          <TableHeader>
            <TableRow>
              <TableHead>Applies to</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>From</TableHead>
              <TableHead>To</TableHead>
              <TableHead>Max km</TableHead>
              <TableHead>Gap tolerance</TableHead>
              <TableHead>Late (pre / post)</TableHead>
              <TableHead>Stale</TableHead>
              <TableHead>Reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {r.rows.map((x) => (
              <TableRow key={x.id} data-testid="settings-history-row">
                <TableCell>{x.vehicle_category ?? "Company default"}</TableCell>
                <TableCell>{x.version}</TableCell>
                <TableCell>{when(x.effective_from)}</TableCell>
                <TableCell>
                  {x.effective_to ? when(x.effective_to) : "now"}
                </TableCell>
                <TableCell>{show(x.max_km_per_allocation)}</TableCell>
                <TableCell>{x.unaccounted_tolerance_km} km</TableCell>
                <TableCell>
                  {x.pre_shift_late_minutes} / {x.post_shift_late_minutes} min
                </TableCell>
                <TableCell>{x.stale_reading_days} days</TableCell>
                <TableCell>{x.reason ?? ""}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}

export default function ValidationSettingsPage() {
  return (
    <AppShell
      title="Odometer validation settings"
      description="Thresholds for the reading checks. A change starts a new version with a reason; earlier versions are kept. The largest plausible distance and the OCR confidence have no default: while empty, the distance check reports 'not configured' and nothing is accepted automatically."
    >
      <Suspense fallback={<Loading label="Loading the settings…" />}>
        <Content />
      </Suspense>
    </AppShell>
  );
}
