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
import type { GroupsSnapshot } from '../../shared/types'
import { getApi } from './api'

interface GroupsContextValue {
  snapshot: GroupsSnapshot | null
  refresh: () => Promise<GroupsSnapshot | null>
}

const GroupsContext = createContext<GroupsContextValue | null>(null)

/** Sync progress and members change on their own; poll like the old share status did. */
const POLL_MS = 2000

export function GroupsProvider({ children }: { children: ReactNode }): ReactElement {
  const [snapshot, setSnapshot] = useState<GroupsSnapshot | null>(null)

  const refresh = useCallback(async (): Promise<GroupsSnapshot | null> => {
    try {
      const next = await getApi().listGroups()
      setSnapshot(next)
      return next
    } catch {
      return null
    }
  }, [])

  useEffect(() => {
    void refresh()
    const id = window.setInterval(() => void refresh(), POLL_MS)
    return () => window.clearInterval(id)
  }, [refresh])

  const value = useMemo(() => ({ snapshot, refresh }), [snapshot, refresh])
  return <GroupsContext.Provider value={value}>{children}</GroupsContext.Provider>
}

export function useGroups(): GroupsContextValue {
  const ctx = useContext(GroupsContext)
  if (!ctx) throw new Error('useGroups must be used within GroupsProvider')
  return ctx
}
