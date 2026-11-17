import Link from "next/link";

const LINKS = [
  { href: "/service/verification", label: "Verification queue" },
  { href: "/service/records/new", label: "Record a service" },
  { href: "/service/import", label: "Baseline import" },
  { href: "/service/config", label: "Configuration" },
];

export function ServiceNav() {
  return (
    <nav
      aria-label="Service"
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
