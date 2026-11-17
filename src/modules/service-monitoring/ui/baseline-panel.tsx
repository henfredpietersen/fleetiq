import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatDate, formatKm } from "../domain/format";
import {
  SERVICE_SCOPE_LABELS,
  type ServiceScope,
} from "../domain/service-config";
import type { Database } from "@/lib/database.types";

type Status = Database["public"]["Views"]["vehicle_service_status"]["Row"];

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="flex justify-between gap-4 border-b py-2 text-sm last:border-0">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="font-medium">{value}</dd>
  </div>
);

/**
 * Vehicle page panel (PRD §5.10.2, §5.10.7). Shows the verified baseline and the next-service values, or
 * "Baseline required". No status bands and no current mileage yet (DEC-10 / Phase 7-8): only derived targets.
 */
export function BaselinePanel({
  status,
  failed,
  canRecord,
}: {
  status: Status | null;
  failed: boolean;
  canRecord: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-3">
          Service baseline
          {status?.baseline_required ? (
            <Badge variant="warning">Baseline required</Badge>
          ) : null}
          {status?.awaiting_verification ? (
            <Badge variant="outline">
              Service recorded — awaiting verification
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription>
          Only a verified service record (verified by someone other than its
          creator) sets the baseline. Nothing is estimated.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {failed ? (
          <Alert variant="destructive">
            The service baseline could not be loaded. Please refresh the page.
          </Alert>
        ) : !status ? (
          <p className="text-muted-foreground text-sm">
            No service information is available for this vehicle.
          </p>
        ) : (
          <>
            {status.baseline_required ? (
              <Alert>
                This vehicle has no verified service record, so no next-service
                values are shown.{" "}
                {canRecord ? (
                  <>
                    <Link href="/service/records/new" className="underline">
                      Record a service
                    </Link>{" "}
                    or{" "}
                    <Link href="/service/import" className="underline">
                      import baselines
                    </Link>
                    ; a different person must then verify it.
                  </>
                ) : (
                  "A maintenance administrator needs to record and verify its last service."
                )}
              </Alert>
            ) : (
              <dl>
                <Row
                  label="Last verified service"
                  value={`${formatDate(status.last_verified_service_date)} · ${formatKm(status.last_verified_service_odometer_km)}`}
                />
                <Row
                  label="Early warning at"
                  value={formatKm(status.early_warning_odometer_km)}
                />
                <Row
                  label="Next service at (target)"
                  value={formatKm(status.next_service_odometer_km)}
                />
                <Row
                  label="Late tolerance limit"
                  value={formatKm(status.late_tolerance_odometer_km)}
                />
                {status.service_due_date ? (
                  <>
                    <Row
                      label="Early warning date"
                      value={formatDate(status.early_warning_date)}
                    />
                    <Row
                      label="Service due date"
                      value={formatDate(status.service_due_date)}
                    />
                    <Row
                      label="Late tolerance date"
                      value={formatDate(status.late_tolerance_date)}
                    />
                  </>
                ) : null}
              </dl>
            )}
            {status.service_interval_km !== null ? (
              <p className="text-muted-foreground text-xs">
                Configuration in effect:{" "}
                {SERVICE_SCOPE_LABELS[
                  status.service_config_scope as ServiceScope
                ] ?? status.service_config_scope}{" "}
                · every {formatKm(status.service_interval_km)} (early −
                {formatKm(status.early_tolerance_km)}, late +
                {formatKm(status.late_tolerance_km)})
                {status.service_interval_days !== null
                  ? ` · or every ${status.service_interval_days} days (early −${status.early_tolerance_days}, late +${status.late_tolerance_days})`
                  : ""}
                .{" "}
                <Link href="/service/config" className="underline">
                  Configuration
                </Link>
              </p>
            ) : (
              <Alert variant="destructive">
                No service configuration applies to this vehicle. Ask a service
                configuration manager to set the company default.
              </Alert>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
