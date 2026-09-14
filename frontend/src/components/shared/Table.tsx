import { For, JSX, Show } from "solid-js";

export interface Column<T> {
  header: string;
  cell: (row: T) => JSX.Element;
}

export function Table<T>(props: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  selectable?: boolean;
  selected?: Set<string>;
  onToggle?: (key: string) => void;
  onToggleAll?: (checked: boolean) => void;
  onRowClick?: (row: T) => void;
}) {
  const allSelected = () =>
    props.rows.length > 0 && props.rows.every((r) => props.selected?.has(props.rowKey(r)));
  return (
    <table class="w-full text-left text-sm">
      <thead class="border-b border-zinc-800 text-xs text-zinc-500">
        <tr>
          <Show when={props.selectable}>
            <th class="w-8 px-2 py-2 font-normal">
              <input
                type="checkbox"
                checked={allSelected()}
                onChange={(e) => props.onToggleAll?.(e.currentTarget.checked)}
              />
            </th>
          </Show>
          <For each={props.columns}>{(c) => <th class="px-2 py-2 font-normal">{c.header}</th>}</For>
        </tr>
      </thead>
      <tbody>
        <For each={props.rows}>
          {(row) => {
            const key = props.rowKey(row);
            return (
              <tr
                class="border-b border-zinc-800/50 hover:bg-white/[0.03] transition-colors"
                onClick={() => props.onRowClick?.(row)}
              >
                <Show when={props.selectable}>
                  <td class="px-2 py-2" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={props.selected?.has(key)}
                      onChange={() => props.onToggle?.(key)}
                    />
                  </td>
                </Show>
                <For each={props.columns}>{(c) => <td class="px-2 py-2">{c.cell(row)}</td>}</For>
              </tr>
            );
          }}
        </For>
      </tbody>
    </table>
  );
}
