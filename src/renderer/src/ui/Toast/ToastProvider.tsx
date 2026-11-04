import { useCallback, useEffect, useRef, useState, type FocusEvent, type ReactElement, type ReactNode } from 'react'
import { subscribeToasts, toast, type ToastItem } from './toast'
import { cx } from '../utils/cx'
import styles from './Toast.module.css'

function ToastCard({ item }: { item: ToastItem }): ReactElement {
  const timerRef = useRef<number | null>(null)
  const startRef = useRef(0)
  const remainingRef = useRef(item.duration)
  const hoverRef = useRef(false)
  const focusRef = useRef(false)

  const pause = useCallback((): void => {
    if (timerRef.current === null) return
    window.clearTimeout(timerRef.current)
    timerRef.current = null
    remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startRef.current))
  }, [])

  const resume = useCallback((): void => {
    if (item.duration <= 0 || timerRef.current !== null) return
    if (hoverRef.current || focusRef.current) return
    startRef.current = Date.now()
    timerRef.current = window.setTimeout(() => toast.dismiss(item.id), remainingRef.current)
  }, [item.id, item.duration])

  useEffect(() => {
    remainingRef.current = item.duration
    resume()
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [item.duration, resume])

  const onBlur = (e: FocusEvent<HTMLDivElement>): void => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    focusRef.current = false
    resume()
  }

  const role = item.variant === 'error' ? 'alert' : 'status'

  return (
    <div
      className={cx(styles.toast, styles[item.variant])}
      role={role}
      aria-live={item.variant === 'error' ? 'assertive' : 'polite'}
      onMouseEnter={() => {
        hoverRef.current = true
        pause()
      }}
      onMouseLeave={() => {
        hoverRef.current = false
        resume()
      }}
      onFocus={() => {
        focusRef.current = true
        pause()
      }}
      onBlur={onBlur}
    >
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
