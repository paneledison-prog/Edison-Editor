import { useState } from 'preact/hooks';
import { easeFn } from '../../../../motion/src/ease';

const FAMILIES = [
  'quad',
  'cubic',
  'quart',
  'quint',
  'sine',
  'expo',
  'circ',
  'back',
  'elastic',
  'bounce',
];
export const EASE_NAMES = [
  'linear',
  'hold',
  ...FAMILIES.flatMap((f) => [`${f}.in`, `${f}.out`, `${f}.inOut`]),
];

const BEZ = /^bezier\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)$/;

/** The curve of an easing name, drawn from the same function the renderer uses (motion/src/ease.ts). */
export function curvePath(name: string, w = 120, h = 80, pad = 12): string {
  let f: (t: number) => number;
  try {
    f = easeFn(name);
  } catch {
    return '';
  }
  const pts: string[] = [];
  for (let i = 0; i <= 48; i++) {
    const t = i / 48;
    const y = f(t);
    pts.push(
      `${i ? 'L' : 'M'}${(pad + t * (w - 2 * pad)).toFixed(1)},${(h - pad - y * (h - 2 * pad)).toFixed(1)}`,
    );
  }
  return pts.join('');
}

interface Props {
  value: string;
  onChange: (ease: string) => void;
  disabled?: boolean;
}

/** Pick a named easing or enter a cubic bezier; the curve preview updates as you type, an edit is sent only when valid. */
export function EaseEditor({ value, onChange, disabled }: Props) {
  const bez = BEZ.exec(value);
  const [custom, setCustom] = useState<string[]>(
    bez ? bez.slice(1, 5) : ['0.2', '0.8', '0.2', '1'],
  );
  const isCustom = !!bez;
  const apply = (c: string[]) => {
    setCustom(c);
    const nums = c.map(Number);
    if (
      c.every((x) => x.trim() !== '' && Number.isFinite(Number(x))) &&
      nums[0]! >= 0 &&
      nums[0]! <= 1 &&
      nums[2]! >= 0 &&
      nums[2]! <= 1
    )
      onChange(`bezier(${nums.join(',')})`);
  };
  return (
    <div class="ease-editor" data-testid="ease-editor">
      <svg class="ease-curve" viewBox="0 0 120 80" role="img" aria-label={`Easing curve ${value}`}>
        <line x1="12" y1="68" x2="108" y2="68" />
        <line x1="12" y1="68" x2="12" y2="12" />
        <path d={curvePath(value)} data-testid="ease-path" />
      </svg>
      <select
        aria-label="Easing"
        value={isCustom ? 'bezier' : value}
        disabled={disabled}
        onChange={(e) => {
          const v = (e.target as HTMLSelectElement).value;
          if (v === 'bezier') apply(custom);
          else onChange(v);
        }}
      >
        {EASE_NAMES.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
        <option value="bezier">cubic bezier…</option>
      </select>
      {isCustom && (
        <div class="bez-inputs">
          {['x1', 'y1', 'x2', 'y2'].map((l, i) => (
            <input
              key={l}
              aria-label={`Bezier ${l}`}
              inputMode="decimal"
              value={custom[i]}
              disabled={disabled}
              onInput={(e) =>
                apply(custom.map((c, j) => (j === i ? (e.target as HTMLInputElement).value : c)))
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
