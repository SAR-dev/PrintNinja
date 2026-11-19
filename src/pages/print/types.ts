import { usePrintStore } from "@/lib/store/printStore";

/**
 * The print store's state. The interface is not exported from the store
 * itself, so the page's sections name it through the store's `getState`
 * (the hook's own overloads would make `ReturnType` pick the selector
 * form and fall back to `unknown`).
 */
export type PrintState = ReturnType<typeof usePrintStore.getState>;
