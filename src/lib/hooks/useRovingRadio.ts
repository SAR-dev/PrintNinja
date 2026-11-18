import { useCallback, useRef, type KeyboardEvent } from "react";

/**
 * Roving tabindex for a radiogroup (WAI-ARIA radiogroup pattern):
 * exactly one member is tabbable, arrow keys move focus and select
 * together (with wrap-around), and Home/End jump to the first and last
 * option. Selection follows focus, so the tabbable member is always
 * the selected one.
 */
export function useRovingRadio(
  count: number,
  selected: number,
  onSelect: (index: number) => void,
) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const move = useCallback(
    (index: number, delta: number) => {
      if (count < 2) return;
      const next = (index + delta + count) % count;
      onSelect(next);
      refs.current[next]?.focus();
    },
    [count, onSelect],
  );

  const onKeyDown = useCallback(
    (index: number) => (e: KeyboardEvent<HTMLButtonElement>) => {
      switch (e.key) {
        case "ArrowRight":
        case "ArrowDown":
          e.preventDefault();
          move(index, 1);
          break;
        case "ArrowLeft":
        case "ArrowUp":
          e.preventDefault();
          move(index, -1);
          break;
        case "Home":
          e.preventDefault();
          move(index, -index);
          break;
        case "End":
          e.preventDefault();
          move(index, count - 1 - index);
          break;
      }
    },
    [move, count],
  );

  return {
    /** Per-option attributes for a `role="radio"` button at `index`. */
    register(index: number) {
      return {
        ref: (el: HTMLButtonElement | null) => {
          refs.current[index] = el;
        },
        tabIndex: index === selected ? 0 : -1,
        onKeyDown: onKeyDown(index),
      };
    },
  };
}
