export type ToastVariant = 'success' | 'error' | 'warning' | 'info'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastShowOptions {
  action?: ToastAction
  /** Auto-dismiss ms. Default 4500 (8000 with an action). Pass 0 to keep until dismissed. */
  duration?: number
}

export interface ToastItem {
  id: string
  variant: ToastVariant
  message: string
  action?: ToastAction
  duration: number
}

type Listener = (items: ToastItem[]) => void

const DEFAULT_DURATION = 4500
const ACTION_DURATION = 8000
const listeners = new Set<Listener>()
let items: ToastItem[] = []
let seq = 0

function emit(): void {
  const snapshot = items.slice()
  for (const listener of listeners) listener(snapshot)
}

function push(variant: ToastVariant, message: string, opts?: ToastShowOptions): string {
  const text = message.trim()
  if (!text) return ''
  const id = `toast-${Date.now()}-${++seq}`
  const duration = opts?.duration ?? (opts?.action ? ACTION_DURATION : DEFAULT_DURATION)
  items = [...items, { id, variant, message: text, action: opts?.action, duration }]
  emit()
  return id
}

function dismiss(id: string): void {
  const next = items.filter((t) => t.id !== id)
  if (next.length === items.length) return
  items = next
  emit()
}

export const toast = {
  success: (message: string, opts?: ToastShowOptions): string => push('success', message, opts),
  error: (message: string, opts?: ToastShowOptions): string => push('error', message, opts),
  warning: (message: string, opts?: ToastShowOptions): string => push('warning', message, opts),
  info: (message: string, opts?: ToastShowOptions): string => push('info', message, opts),
  dismiss
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener)
  listener(items.slice())
  return () => {
    listeners.delete(listener)
  }
}
