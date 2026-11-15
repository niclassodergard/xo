/** An action chip: a real button (click, touch, Tab). `highlighted` is the keyboard highlight (visual only). */
export function Chip(props: {
  label: string; onClick: () => void; highlighted?: boolean; danger?: boolean; id?: string; tabIndex?: number;
}) {
  return (
    <button
      type="button" id={props.id} tabIndex={props.tabIndex}
      class={`chip${props.highlighted ? ' highlighted' : ''}${props.danger ? ' danger' : ''}`}
      onClick={(e) => { e.stopPropagation(); props.onClick(); }}
    >
      {props.label}
    </button>
  );
}
