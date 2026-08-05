import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { subscribeToasts, toast, type ToastItem } from './toast'
import { cx } from '../utils/cx'
import styles from './Toast.module.css'

function ToastCard({ item }: { item: ToastItem }): ReactElement {
  useEffect(() => {
    if (item.duration <= 0) return
    const id = window.setTimeout(() => toast.dismiss(item.id), item.duration)
    return () => window.clearTimeout(id)
  }, [item.id, item.duration])

  const role = item.variant === 'error' ? 'alert' : 'status'

  return (
    <div className={cx(styles.toast, styles[item.variant])} role={role} aria-live={item.variant === 'error' ? 'assertive' : 'polite'}>
      <p className={styles.message}>{item.message}</p>
      <div className={styles.actions}>
        {item.action ? (
          <button
            type="button"
            className={styles.action}
            onClick={() => {
              item.action?.onClick()
              toast.dismiss(item.id)
            }}
          >
            {item.action.label}
          </button>
        ) : null}
        <button
          type="button"
          className={styles.dismiss}
          aria-label="Cerrar"
          onClick={() => toast.dismiss(item.id)}
        >
          ×
        </button>
      </div>
    </div>
  )
}

export function ToastProvider({ children }: { children: ReactNode }): ReactElement {
  const [items, setItems] = useState<ToastItem[]>([])

  useEffect(() => subscribeToasts(setItems), [])

  return (
    <>
      {children}
      <div className={styles.viewport} aria-label="Notificaciones">
        {items.map((item) => (
          <ToastCard key={item.id} item={item} />
        ))}
      </div>
    </>
  )
}

export function useToast(): typeof toast {
  return toast
}
