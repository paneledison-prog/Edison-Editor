import type { ComponentChildren } from 'preact';

export function PanelHeader({ title, children }: { title: string; children?: ComponentChildren }) {
  return (
    <header class="panel-header">
      <h2>{title}</h2>
      {children}
    </header>
  );
}

export function EmptyState({ children }: { children: ComponentChildren }) {
  return <p class="empty">{children}</p>;
}
