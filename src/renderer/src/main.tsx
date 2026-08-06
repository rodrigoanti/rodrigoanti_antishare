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

const root = document.getElementById('root')
if (!root) {
  throw new Error('Root element #root not found')
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
