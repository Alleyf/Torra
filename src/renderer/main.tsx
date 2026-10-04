import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { initTheme } from './theme'
import './styles.css'

// preload 已按冷启动主题写好 data-theme，这里向主进程核对一次并订阅后续变化
initTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
