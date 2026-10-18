"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "Overview" },
  { href: "/incidents", label: "Incidents" },
  { href: "/review", label: "Review Queue" },
  { href: "/actions", label: "Corrective Actions" },
  { href: "/reports", label: "Reports" },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Main">
      {ITEMS.map((i) => {
        const active = i.href === "/" ? path === "/" : path.startsWith(i.href);
        return <Link key={i.href} href={i.href} aria-current={active ? "page" : undefined}>{i.label}</Link>;
      })}
    </nav>
  );
}
