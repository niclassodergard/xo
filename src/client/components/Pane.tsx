import type { ComponentChildren } from 'preact';

const RULE = '─'.repeat(300);

/** A box-drawing pane: ┌─ Title ────┐ / │ body │ / └────────┘ (sides are CSS borders). */
export function Pane(props: { title: string; children?: ComponentChildren; focused?: boolean; class?: string }) {
  return (
    <section class={`pane${props.focused ? ' focused' : ''}${props.class ? ` ${props.class}` : ''}`}>
      <div class="pane-top">
        <span class="pane-corner" aria-hidden="true">┌─ </span>
        <h2 class="pane-title">{props.title}</h2>
        <span class="pane-rule" aria-hidden="true">{` ${RULE}`}</span>
        <span class="pane-corner" aria-hidden="true">┐</span>
      </div>
      <div class="pane-body">{props.children}</div>
      <div class="pane-bottom" aria-hidden="true">
        <span class="pane-corner" aria-hidden="true">└</span>
        <span class="pane-rule">{RULE}</span>
        <span class="pane-corner" aria-hidden="true">┘</span>
      </div>
    </section>
  );
}
