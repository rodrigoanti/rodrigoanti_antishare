import { useCallback, useState, type ReactElement } from 'react'
import { Home } from './screens/Home'
import { ShareSettings } from './screens/MyShare'
import { ShareStatusProvider, useShareStatus } from './shareStatus'
import { SidePanel, ToastProvider } from './ui'

function AppShell(): ReactElement {
  const { status } = useShareStatus()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [homeKey, setHomeKey] = useState(0)

  const openLocalFromSettings = useCallback(() => {
    setSettingsOpen(false)
    sessionStorage.setItem('antishare.openLocal', '1')
    setHomeKey((k) => k + 1)
  }, [])

  return (
    <div className="app-shell">
      <main className="app-body">
        <Home
          key={homeKey}
          status={status}
          settingsOpen={settingsOpen}
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
        <ShareSettings onOpenLocal={openLocalFromSettings} />
      </SidePanel>
    </div>
  )
}

export function App(): ReactElement {
  return (
    <ToastProvider>
      <ShareStatusProvider>
        <AppShell />
      </ShareStatusProvider>
    </ToastProvider>
  )
}
