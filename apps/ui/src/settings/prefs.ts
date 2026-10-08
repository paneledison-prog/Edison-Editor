/** Per-viewer preferences, kept in the browser. Every read and write is wrapped: with blocked storage the page still works. */
export interface Prefs {
  /** timeline zoom at load, in pixels per second */
  zoomPxPerSec: number;
  showKeyframes: boolean;
}
export const DEFAULT_PREFS: Prefs = { zoomPxPerSec: 100, showKeyframes: true };
const KEY = 'studio-prefs';

export function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    const z = Number(raw.zoomPxPerSec);
    return {
      zoomPxPerSec: Number.isFinite(z) && z >= 2 && z <= 2000 ? z : DEFAULT_PREFS.zoomPxPerSec,
      showKeyframes:
        typeof raw.showKeyframes === 'boolean' ? raw.showKeyframes : DEFAULT_PREFS.showKeyframes,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* the choice lasts for this page only */
  }
}
