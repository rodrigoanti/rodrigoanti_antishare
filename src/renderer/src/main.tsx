import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { getApi } from './api'
import { applyTheme, getInitialTheme } from './theme'
import './styles/global.css'
import './styles/motion.css'
import './styles.css'

document.documentElement.dataset.platform = getApi().platform
applyTheme(getInitialTheme())

// Files dropped outside a drop zone would make Chromium open them in place of the app.
// Bubble phase: zones that accept the drop already called preventDefault.
window.addEventListener('dragover', (e) => {
  if (e.defaultPrevented || !e.dataTransfer?.types.includes('Files')) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'none'
})
window.addEventListener('drop', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return
  e.preventDefault()
})

const root = document.getElementById('root')
if (!root) {
  throw new Error('Root element #root not found')
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
