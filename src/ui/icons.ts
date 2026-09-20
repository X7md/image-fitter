// Inline SVG icons (Material-like 24px outlines). Every icon is a stroke path so the
// whole set inherits `currentColor` and stays crisp at any size.

const wrap = (body: string, cls = ''): string =>
  `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"${cls ? ` class="${cls}"` : ''}>${body}</svg>`

export const icons = {
  /** App mark: a frame with a picture being fitted inside. */
  logo: wrap(
    '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M7 15.5 10 12l2.5 3 1.5-1.8 3 3.8"/><circle cx="15.5" cy="8.5" r="1.5"/>',
  ),
  open: wrap('<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/><path d="M12 3v13"/><path d="m7 8 5-5 5 5"/>'),
  reset: wrap('<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3 3v6h6"/>'),
  save: wrap('<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/><path d="M12 3v13"/><path d="m7 11 5 5 5-5"/>'),
  ratio: wrap('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 11V8h3"/><path d="M17 13v3h-3"/>'),
  size: wrap('<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M3 9V3h6"/><path d="M21 15v6h-6"/>'),
  position: wrap(
    '<path d="M12 3v18M3 12h18"/><path d="m9 6 3-3 3 3"/><path d="m9 18 3 3 3-3"/><path d="m6 9-3 3 3 3"/><path d="m18 9 3 3-3 3"/>',
  ),
  background: wrap(
    '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 15.5 8 11l4 4 2.5-2.5L21 18"/><circle cx="15.5" cy="8" r="1.5"/>',
  ),
  swap: wrap('<path d="M7 20V5"/><path d="m3 9 4-4 4 4"/><path d="M17 4v15"/><path d="m21 15-4 4-4-4"/>'),
  up: wrap('<path d="m6 15 6-6 6 6"/>'),
  down: wrap('<path d="m6 9 6 6 6-6"/>'),
  left: wrap('<path d="m15 6-6 6 6 6"/>'),
  right: wrap('<path d="m9 6 6 6-6 6"/>'),
  image: wrap(
    '<rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M3 16l5-5 4 4 2.5-2.5L21 19"/><circle cx="16" cy="8" r="1.75"/>',
  ),
  warning: wrap('<path d="M12 4 2.5 20h19L12 4z"/><path d="M12 10v4"/><path d="M12 17.5v.5"/>'),
  check: wrap('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  spinner: wrap('<path d="M12 3a9 9 0 1 1-6.4 2.6"/>', 'spin'),
} as const

export type IconName = keyof typeof icons
