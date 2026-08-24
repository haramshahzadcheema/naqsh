/**
 * One small, self-contained line-icon set -- replaces the handful of
 * full-color EMOJI glyphs (📄 📎 🗑) that had crept in alongside this
 * app's otherwise deliberately monochrome, restrained visual language.
 * An emoji renders in the PLATFORM's own multi-color pictogram style,
 * completely outside this app's own color system, at a weight and
 * proportion nothing else on screen matches -- exactly the "inconsistent
 * icons" this pass is meant to fix. Every icon here is `currentColor`
 * (inherits real text color, respects the current tone/theme) at one
 * shared stroke width, sized to sit inline with text.
 *
 * Deliberately NOT every symbol in the app -- the Unicode glyphs already
 * used for +, ⌕, ⚙, ☰, ▸, ▾, ✓, × render as plain TEXT glyphs in every
 * mainstream UI font (they're outside the ranges platforms give an emoji
 * presentation to), so they already behave like real icons and don't
 * need replacing.
 */
import type { SVGProps } from "react";

function iconProps(props: SVGProps<SVGSVGElement>): SVGProps<SVGSVGElement> {
  return { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, ...props };
}

export function PencilIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <path d="M11 2.5 13.5 5 5 13.5H2.5V11z" />
    </svg>
  );
}

export function TrashIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <path d="M2.5 4.5h11" />
      <path d="M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5" />
      <path d="M4.5 4.5 5 13a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l.5-8.5" />
    </svg>
  );
}

export function PinIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <circle cx="8" cy="6" r="3.5" />
      <path d="M8 9.5v5" />
    </svg>
  );
}

export function ArchiveIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <path d="M2.5 4.5h11v2.5h-11z" />
      <path d="M3.5 7v6a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V7" />
      <path d="M6.5 9.5h3" />
    </svg>
  );
}

export function PaperclipIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <path d="M11.5 5.5 6.6 10.4a2 2 0 0 0 2.83 2.83l4.6-4.6a3.4 3.4 0 0 0-4.81-4.81L4.4 8.65a4.6 4.6 0 0 0 6.5 6.5" />
    </svg>
  );
}

export function DocumentIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg {...iconProps(props)}>
      <path d="M4.5 1.5h5l3 3v9a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z" />
      <path d="M9.5 1.5v3h3" />
    </svg>
  );
}
