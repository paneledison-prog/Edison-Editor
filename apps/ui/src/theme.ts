export type Theme = 'light' | 'dark';
const KEY = 'studio-theme';

/** The inline script in index.html has already set data-theme before first paint. */
export const currentTheme = (): Theme =>
  document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';

export function setTheme(t: Theme): void {
  document.documentElement.setAttribute('data-theme', t);
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* private window or blocked storage: the choice lasts for this page only */
  }
}
