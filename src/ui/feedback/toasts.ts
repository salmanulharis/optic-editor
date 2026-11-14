/**
 * Non-blocking feedback: short messages with an optional action (usually Undo). Callable from any
 * module (no React needed); rendered by <Toaster />.
 */
import { create } from 'zustand';

export interface ToastAction {
  label: string;
  run(): void;
}

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error';
  action?: ToastAction;
  /** Milliseconds before it hides by itself (paused while hovered or focused); 0 = stays. */
  duration: number;
}

interface ToastState {
  toasts: Toast[];
  push(t: Omit<Toast, 'id' | 'duration' | 'kind'> & Partial<Pick<Toast, 'duration' | 'kind'>>): number;
  dismiss(id: number): void;
}

const MAX = 3;
let next = 1;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push(t) {
    const id = next++;
    const toast: Toast = { duration: t.kind === 'error' ? 0 : 6000, kind: 'info', ...t, id };
    set({ toasts: [...get().toasts, toast].slice(-MAX) });
    return id;
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

/** Show a message, e.g. toast('All adjustments reset', { label: 'Undo', run: undo }). */
export function toast(message: string, action?: ToastAction): number {
  return useToasts.getState().push({ message, action });
}

export function toastError(message: string): number {
  return useToasts.getState().push({ message, kind: 'error' });
}
