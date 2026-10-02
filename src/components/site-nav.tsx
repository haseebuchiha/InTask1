"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const SITE_LINKS: SiteLink[] = [
  { href: "/", label: "Dashboard", sectionPrefix: "/pings/" },
  { href: "/incidents", label: "Incidents", sectionPrefix: "/incidents/" },
]

type SiteLink = { href: string; label: string; sectionPrefix: string }

export const SiteNav = () => {
  const pathname = usePathname()
  return (
    <nav aria-label="Site" className="flex items-center gap-1">
      {SITE_LINKS.map((siteLink) => (
        <SiteNavLink key={siteLink.href} siteLink={siteLink} isCurrent={isInSection(pathname, siteLink)} />
      ))}
    </nav>
  )
}

const SiteNavLink = ({ siteLink, isCurrent }: { siteLink: SiteLink; isCurrent: boolean }) => (
  <Link
    href={siteLink.href}
    aria-current={isCurrent ? "page" : undefined}
    className={cn(buttonVariants({ variant: isCurrent ? "secondary" : "ghost", size: "sm" }))}
  >
    {siteLink.label}
  </Link>
)

const isInSection = (pathname: string, { href, sectionPrefix }: SiteLink) =>
  pathname === href || pathname.startsWith(sectionPrefix)
