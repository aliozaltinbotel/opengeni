import { forwardRef, type ComponentPropsWithoutRef, type SVGProps } from "react";

import { useAppHost } from "../lib/app-host";
import { cn } from "../lib/utils";

/*
 * The Opengeni brand: the iconmark and the wordmark. This file is the one
 * place to swap either; every surface (rails, mobile header, sign-in, credits
 * row) renders these components. The favicon and app icons in `public/` use
 * the same mark. A host extension's `brand` (on the AppHost) replaces both.
 */

const STOCK_PRODUCT_NAME = "Opengeni";

/** The product name to show: the host extension's, else "Opengeni". */
export function useProductName(): string {
  return useAppHost().productName ?? STOCK_PRODUCT_NAME;
}

/**
 * The console's brand mark: the host extension's mark when it has one, else
 * the Opengeni iconmark. Surfaces that name Opengeni itself (the credits
 * provider) use `OpengeniMark`, which a host brand never replaces.
 */
export function BrandMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  const HostMark = useAppHost().brand?.mark;
  if (HostMark) return <HostMark className={cn("h-auto shrink-0", className)} />;
  return <OpengeniMark className={className} {...props} />;
}

/**
 * The Opengeni iconmark: two stacked filled chevrons, wider than tall
 * (176:138.73). Filled with currentColor, so it takes the surrounding text
 * color (`fg`, never a brand tint). Size it by width (`w-5`); the height
 * follows the aspect ratio.
 */
export function OpengeniMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 176 138.73"
      fill="currentColor"
      aria-hidden="true"
      className={cn("h-auto shrink-0", className)}
      {...props}
    >
      <path
        transform="translate(-75 -39.5966)"
        d="M251 83.5966L207 109L163 83.5966L119 109L75 83.5966L141 45.4915A44 44 0 0 1 185 45.4915ZM185.25 172.3642A44.5 44.5 0 0 1 140.75 172.3642L75 134.4034L119 109L163 134.4034L207 109L251 134.4034Z"
      />
    </svg>
  );
}

/**
 * The "Opengeni" wordmark: DM Sans at weight 550, -0.055em tracking, line
 * height 1. Set the size for the context with a text utility; pair it with a
 * BrandMark about 1.35x the font size wide. A host wordmark renders inside a
 * span that takes the same size, so it should size itself in `em`.
 */
export const Wordmark = /* @__PURE__ */ forwardRef<
  HTMLSpanElement,
  ComponentPropsWithoutRef<"span">
>(function Wordmark({ className, ...props }, ref) {
  const HostWordmark = useAppHost().brand?.wordmark;
  if (HostWordmark) {
    return (
      <span className={cn("inline-flex items-center leading-none", className)} ref={ref} {...props}>
        <HostWordmark />
      </span>
    );
  }
  return (
    <span
      className={cn("font-display leading-none font-[550] tracking-[-0.055em]", className)}
      ref={ref}
      {...props}
    >
      Opengeni
    </span>
  );
});
