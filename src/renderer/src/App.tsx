import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { ShareStatus } from '../../shared/types'
import { getApi } from './api'
import { Home } from './screens/Home'
import { ShareSettings } from './screens/MyShare'
import { Button, SidePanel } from './ui'

export function App(): ReactElement {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [localStatus, setLocalStatus] = useState<ShareStatus | null>(null)
  const [homeKey, setHomeKey] = useState(0)

  useEffect(() => {
    const api = getApi()
    let alive = true

    async function tick(): Promise<void> {
      try {
        const status = await api.shareStatus()
        if (alive) setLocalStatus(status)
      } catch {
        /* ignore */
      }
    }

    void tick()
    const id = window.setInterval(() => void tick(), 3000)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [])

  const openLocalFromSettings = useCallback(() => {
    setSettingsOpen(false)
    // Remount Home so it can start at local root via session hint
    sessionStorage.setItem('antishare.openLocal', '1')
    setHomeKey((k) => k + 1)
  }, [])

  const shareRunning = localStatus?.running ?? false

  return (
    <div className="app-shell">
      <header className="topbar">
        <button
          type="button"
          className="brand"
          onClick={() => {
            sessionStorage.removeItem('antishare.openLocal')
            setHomeKey((k) => k + 1)
          }}
          aria-label="AntiShare — Compartidos"
        >
          AntiShare
        </button>
        <div className="topbar-right">
          <span className={`share-pill ${shareRunning ? 'on' : ''}`} aria-live="polite">
            <span className={`status-dot ${shareRunning ? 'on' : 'off'}`} aria-hidden="true" />
            {shareRunning ? 'Compartiendo' : 'Sin compartir'}
          </span>
          <Button
            variant="secondary"
            size="md"
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen(true)}
          >
            Configurar
          </Button>
        </div>
      </header>

      <main className="main finder-main">
        <Home
          key={homeKey}
          status={localStatus}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      </main>

      <SidePanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Carpeta local"
        size="sm"
        side="right"
      >
        <ShareSettings onOpenLocal={openLocalFromSettings} onStatusChange={setLocalStatus} />
      </SidePanel>
    </div>
  )
}
