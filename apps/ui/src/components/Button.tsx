import type { ComponentChildren, JSX } from 'preact';

type Variant = 'action' | 'secondary' | 'ghost';
type BtnProps = Omit<JSX.IntrinsicElements['button'], 'size' | 'ref'>;

interface Props extends BtnProps {
  variant?: Variant;
  children: ComponentChildren;
}

/** `action` is reserved for the single primary action in a view. */
export function Button({ variant = 'secondary', class: cls, children, ...rest }: Props) {
  return (
    <button type="button" class={`btn btn-${variant} ${cls ?? ''}`} {...rest}>
      {children}
    </button>
  );
}

interface IconProps extends BtnProps {
  label: string;
  shortcut?: string;
  pressed?: boolean;
  children: ComponentChildren;
}

/** Icon-only button: always has an accessible name, and the tooltip shows the shortcut. */
export function IconButton({ label, shortcut, pressed, class: cls, children, ...rest }: IconProps) {
  return (
    <button
      type="button"
      class={`icon-btn ${cls ?? ''}`}
      aria-label={label}
      aria-pressed={pressed}
      title={shortcut ? `${label} (${shortcut})` : label}
      {...rest}
    >
      {children}
    </button>
  );
}
