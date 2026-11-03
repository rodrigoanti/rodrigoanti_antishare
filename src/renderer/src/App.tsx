import type { ReactElement } from 'react'
import { Home } from './screens/Home'
import { GroupsProvider } from './groups'
import { ToastProvider } from './ui'

export function App(): ReactElement {
  return (
    <ToastProvider>
      <GroupsProvider>
        <div className="app-shell">
          <main className="app-body">
            <Home />
          </main>
        </div>
      </GroupsProvider>
    </ToastProvider>
  )
}
