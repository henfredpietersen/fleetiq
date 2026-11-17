import { Badge } from "@/components/ui/badge";
import type { LicenceBadge as LicenceBadgeValue } from "../domain/licence-expiry";

const VARIANT = {
  none: "outline",
  valid: "success",
  expiring: "warning",
  expired: "destructive",
  unverified: "warning",
} as const;

/** The licence expiry warning shown in the register (PRD §5.4). Text, not colour alone, carries the meaning. */
export function LicenceBadge({ badge }: { badge: LicenceBadgeValue }) {
  return <Badge variant={VARIANT[badge.state]}>{badge.label}</Badge>;
}
