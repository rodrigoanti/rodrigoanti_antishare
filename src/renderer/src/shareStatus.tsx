import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'
import type { ShareStatus } from '../../shared/types'
import { getApi } from './api'

interface ShareStatusContextValue {
  status: ShareStatus | null
  refreshStatus: () => Promise<ShareStatus | null>
  setStatus: (status: ShareStatus | null) => void
}

const ShareStatusContext = createContext<ShareStatusContextValue | null>(null)

const POLL_MS = 2000

export function ShareStatusProvider({ children }: { children: ReactNode }): ReactElement {
  const [status, setStatus] = useState<ShareStatus | null>(null)

  const refreshStatus = useCallback(async (): Promise<ShareStatus | null> => {
    try {
      const next = await getApi().shareStatus()
      setStatus(next)
      return next
    } catch {
      return null
    }
  }, [])

  useEffect(() => {
    let alive = true

    async function tick(): Promise<void> {
      try {
        const next = await getApi().shareStatus()
        if (alive) setStatus(next)
      } catch {
        /* ignore */
      }
    }

    void tick()
    const id = window.setInterval(() => void tick(), POLL_MS)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [])

  const value = useMemo(
    () => ({ status, refreshStatus, setStatus }),
    [status, refreshStatus]
  )

  return <ShareStatusContext.Provider value={value}>{children}</ShareStatusContext.Provider>
}

export function useShareStatus(): ShareStatusContextValue {
  const ctx = useContext(ShareStatusContext)
  if (!ctx) {
    throw new Error('useShareStatus must be used within ShareStatusProvider')
  }
  return ctx
}
