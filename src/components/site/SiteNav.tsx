"use client";

import Link from "next/link";

export type NavItem = { href: string; label: string };

// An in-page link is a plain anchor (smooth-scrolled); a route is a Link.
function Go({ href, className, children }: { href: string; className: string; children: React.ReactNode }) {
  return href.startsWith("#") ? (
    <a href={href} className={className}>{children}</a>
  ) : (
    <Link href={href} className={className}>{children}</Link>
  );
}

// The floating pill every marketing page shares.
export default function SiteNav({ tag, links, cta, account }: { tag?: string; links: NavItem[]; cta: NavItem; account?: NavItem | null }) {
  return (
    <header className="pointer-events-none sticky top-0 z-50 px-3 pt-3 sm:pt-4">
      <nav className="glass pointer-events-auto mx-auto flex max-w-[1140px] items-center justify-between gap-2 rounded-full py-1.5 pl-4 pr-1.5 shadow-[0_12px_40px_-20px_rgba(0,0,0,0.55)]">
        <Link href="/" className="mono flex shrink-0 items-center gap-2 text-[14px] font-semibold tracking-tight">
          <span className="h-2 w-2 rounded-full bg-[color:var(--brand)] shadow-[0_0_12px_var(--glow)]" aria-hidden />
          <span>
            ping<span className="text-[color:var(--faint)]">.chat</span>
          </span>
          {tag && <span className="ml-0.5 hidden rounded-full border border-border px-2 py-0.5 text-[10.5px] font-normal text-muted sm:inline">{tag}</span>}
        </Link>
        <div className="hidden items-center gap-6 text-[13.5px] text-muted md:flex">
          {links.map((l) => (
            <Go key={l.href} href={l.href} className="transition hover:text-text">
              {l.label}
            </Go>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {account && (
            <Go href={account.href} className="hidden rounded-full px-3 py-2 text-[13.5px] text-muted transition hover:text-text sm:inline">
              {account.label}
            </Go>
          )}
          <Go href={cta.href} className="btn px-4 py-2 text-[13px]">
            {cta.label}
          </Go>
        </div>
      </nav>
    </header>
  );
}
