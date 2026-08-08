"use client";

import AnimatedThemeToggler from "@/components/AnimatedThemeToggler";

// Ping's theme toggle — the Magic UI animated toggler with our OLED styling.
export default function ThemeToggle({ className = "" }: { className?: string }) {
  return <AnimatedThemeToggler className={`theme-toggle ${className}`} variant="circle" duration={480} />;
}
