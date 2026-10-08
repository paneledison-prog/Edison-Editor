import { wsId, type WsView } from '../api';

/** The five workspaces of this editor, one tab each. A dot shows an agent working in it; the page opened on it is view-only then. */
export function WorkspaceTabs({ view }: { view: WsView }) {
  return (
    <nav class="ws-tabs" aria-label="Workspaces" role="tablist" data-testid="ws-tabs">
      {view.workspaces.map((w) => {
        const busy = w.state === 'agent-working';
        const here = w.slot === wsId;
        return (
          <a
            key={w.slot}
            role="tab"
            href={`?ws=${w.slot}`}
            aria-selected={here}
            aria-label={`${w.slot} ${w.name}, ${busy ? `${w.agent} is working` : 'idle'}`}
            class={`ws-tab${here ? ' on' : ''}${busy ? ' busy' : ''}`}
            data-ws={w.slot}
            data-state={w.state}
            title={busy ? `${w.agent} is working${w.note ? `: ${w.note}` : ''}` : `${w.items} clip${w.items === 1 ? '' : 's'}, ${w.assets} asset${w.assets === 1 ? '' : 's'}`}
          >
            <span class="ws-dot" aria-hidden="true" />
            <span class="ws-slot">{w.slot}</span>
            <span class="ws-name">{w.name}</span>
          </a>
        );
      })}
    </nav>
  );
}
