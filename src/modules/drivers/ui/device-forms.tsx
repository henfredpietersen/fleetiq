"use client";

import { useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { DEVICE_STATUS_LABEL, type DeviceRow } from "../domain/device-schema";
import {
  assignDeviceAction,
  registerDeviceAction,
  setDeviceStatusAction,
  unassignDeviceAction,
  type DeviceReply,
} from "../server/device-actions";

function useReply() {
  const [reply, setReply] = useState<DeviceReply | null>(null);
  const [pending, start] = useTransition();
  const run = (f: () => Promise<DeviceReply>) =>
    start(async () => {
      try {
        setReply(await f());
      } catch {
        setReply({ ok: false, message: "No connection. Please try again." });
      }
    });
  return { reply, pending, run };
}
function Reply({ reply }: { reply: DeviceReply | null }) {
  if (!reply) return null;
  return (
    <Alert variant={reply.ok ? "success" : "destructive"} role="status">
      <p>{reply.message}</p>
      {!reply.ok && reply.details?.length ? (
        <ul className="list-disc pl-5">
          {reply.details.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      ) : null}
    </Alert>
  );
}

export function RegisterDeviceForm({
  branches,
}: {
  branches: { id: string; name: string }[];
}) {
  const { reply, pending, run } = useReply();
  return (
    <form
      aria-label="Register a phone"
      className="flex max-w-xl flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        run(() =>
          registerDeviceAction({
            branchId: f.get("branchId"),
            deviceKey: f.get("deviceKey"),
            assetTag: f.get("assetTag"),
            label: f.get("label"),
          }),
        );
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="branchId">Branch</Label>
        <Select
          id="branchId"
          name="branchId"
          required
          defaultValue={branches.length === 1 ? branches[0]!.id : ""}
        >
          <option value="" disabled>
            Choose a branch
          </option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="deviceKey">Phone code</Label>
        <Input
          id="deviceKey"
          name="deviceKey"
          required
          autoComplete="off"
          autoCapitalize="none"
          placeholder="From the phone's “This phone” screen"
        />
        <p className="text-muted-foreground text-xs">
          Open “This phone” on the company phone, copy the full code and paste
          it here. It identifies the app on that phone, not the hardware; it is
          used only to flag an inspection made on a different phone.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="assetTag">Asset tag (optional)</Label>
        <Input id="assetTag" name="assetTag" maxLength={60} />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="label">Label (optional)</Label>
        <Input
          id="label"
          name="label"
          maxLength={100}
          placeholder="For example: Hilux phone 3"
        />
      </div>
      <Reply reply={reply} />
      <Button type="submit" disabled={pending} className="w-fit">
        {pending ? "Registering…" : "Register phone"}
      </Button>
    </form>
  );
}

export function DeviceRowActions({
  d,
  drivers,
}: {
  d: DeviceRow;
  drivers: { id: string; label: string }[];
}) {
  const { reply, pending, run } = useReply();
  const [reason, setReason] = useState("");
  const [driverId, setDriverId] = useState("");
  const assigned = d.assignedDriverId !== null;
  const needReason = reason.trim() === "";
  return (
    <div className="flex min-w-64 flex-col gap-2" data-testid="device-actions">
      <Label htmlFor={`reason-${d.id}`} className="sr-only">
        Reason
      </Label>
      <Input
        id={`reason-${d.id}`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (required)"
        maxLength={500}
      />
      {d.status === "active" && !assigned ? (
        <div className="flex gap-2">
          <Label htmlFor={`driver-${d.id}`} className="sr-only">
            Driver
          </Label>
          <Select
            id={`driver-${d.id}`}
            value={driverId}
            onChange={(e) => setDriverId(e.target.value)}
          >
            <option value="">Choose a driver</option>
            {drivers.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </Select>
          <Button
            type="button"
            disabled={pending || needReason || !driverId}
            onClick={() =>
              run(() =>
                assignDeviceAction({ deviceId: d.id, driverId, reason }),
              )
            }
          >
            Assign
          </Button>
        </div>
      ) : null}
      {assigned ? (
        <Button
          type="button"
          variant="outline"
          disabled={pending || needReason}
          onClick={() =>
            run(() => unassignDeviceAction({ deviceId: d.id, reason }))
          }
        >
          Unassign
        </Button>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {d.status === "active" ? (
          <Button
            type="button"
            variant="outline"
            disabled={pending || needReason}
            onClick={() =>
              run(() =>
                setDeviceStatusAction({
                  deviceId: d.id,
                  status: "lost",
                  reason,
                }),
              )
            }
          >
            Mark lost
          </Button>
        ) : null}
        {d.status === "lost" ? (
          <Button
            type="button"
            variant="outline"
            disabled={pending || needReason}
            onClick={() =>
              run(() =>
                setDeviceStatusAction({
                  deviceId: d.id,
                  status: "active",
                  reason,
                }),
              )
            }
          >
            Mark found
          </Button>
        ) : null}
        {d.status !== "retired" ? (
          <Button
            type="button"
            variant="outline"
            disabled={pending || needReason}
            onClick={() =>
              run(() =>
                setDeviceStatusAction({
                  deviceId: d.id,
                  status: "retired",
                  reason,
                }),
              )
            }
          >
            Retire
          </Button>
        ) : null}
      </div>
      <Reply reply={reply} />
    </div>
  );
}

export function DeviceStatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant={
        status === "active"
          ? "success"
          : status === "lost"
            ? "destructive"
            : "outline"
      }
    >
      {DEVICE_STATUS_LABEL[status] ?? status}
    </Badge>
  );
}
