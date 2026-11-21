"use client";

import { useEffect, useState } from "react";

// Section links that follow the reader: the one being read lights up.
export default function PolicyNav({ items }: { items: { id: string; title: string }[] }) {
  const [active, setActive] = useState(items[0]?.id);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        const seen = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (seen[0]) setActive(seen[0].target.id);
      },
      { rootMargin: "-25% 0px -65% 0px" }
    );
    for (const { id } of items) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [items]);

  return (
    <ul className="space-y-0.5 text-sm">
      {items.map(({ id, title }) => {
        const on = active === id;
        return (
          <li key={id}>
            <a
              href={`#${id}`}
              aria-current={on ? "location" : undefined}
              className={`flex items-center gap-3 rounded-lg px-2 py-1.5 transition ${on ? "text-text" : "text-muted hover:text-text"}`}
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full transition-all duration-300 ${on ? "scale-150 bg-white shadow-[0_0_10px_rgba(255,255,255,0.8)]" : "bg-[color:var(--faint)]"}`}
              />
              {title}
            </a>
          </li>
        );
      })}
    </ul>
  );
}
