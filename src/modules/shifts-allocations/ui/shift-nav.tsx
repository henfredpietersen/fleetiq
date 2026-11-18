import Link from "next/link";

const LINKS = [
  { href: "/shifts", label: "Shifts" },
  { href: "/shifts/templates", label: "Shift templates" },
  { href: "/shifts/allocations", label: "Allocations" },
  { href: "/shifts/allocations/overrides", label: "Licence overrides" },
];

export function ShiftNav() {
  return (
    <nav
      aria-label="Shifts"
      className="flex flex-wrap gap-x-6 gap-y-2 border-b pb-3"
    >
      {LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          className="text-sm font-medium hover:underline"
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
