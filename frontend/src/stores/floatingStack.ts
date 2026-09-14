import { createEffect, createSignal, onCleanup } from "solid-js";

// Shared registry so multiple bottom-left floating status widgets (pull,
// upload, create, upgrade — each owned by a different component instance)
// stack vertically instead of overlapping at the same fixed position.

interface Slot { id: number; height: number; }

const [slots, setSlots] = createSignal<Slot[]>([]);
let nextId = 0;

const BASE_OFFSET = 16; // matches bottom-4
const GAP = 12;

// Call once per widget instance. `active` controls whether this widget
// currently occupies a slot in the stack. Returns a ref-setter to attach to
// the widget's root element (for height measurement) and a reactive `offset`
// (px) to use as its `bottom` style.
export function useFloatingSlot(active: () => boolean) {
  const id = nextId++;
  let ro: ResizeObserver | undefined;

  createEffect(() => {
    if (active()) {
      setSlots((s) => (s.some((x) => x.id === id) ? s : [...s, { id, height: 0 }]));
    } else {
      setSlots((s) => s.filter((x) => x.id !== id));
    }
  });
  onCleanup(() => {
    ro?.disconnect();
    setSlots((s) => s.filter((x) => x.id !== id));
  });

  const setRef = (el: HTMLDivElement) => {
    ro?.disconnect();
    ro = new ResizeObserver(() => {
      setSlots((s) => s.map((x) => (x.id === id ? { ...x, height: el.offsetHeight } : x)));
    });
    ro.observe(el);
  };

  const offset = () => {
    const list = slots();
    const idx = list.findIndex((x) => x.id === id);
    if (idx <= 0) return BASE_OFFSET;
    return BASE_OFFSET + list.slice(0, idx).reduce((sum, s) => sum + s.height + GAP, 0);
  };

  return { setRef, offset };
}
