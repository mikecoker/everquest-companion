import { createRoot } from 'react-dom/client'
import { App, type AppDeps } from '../../activity/src/App'
import { createActivityApi } from '../../activity/src/api'
import { browserDelay } from '../../activity/src/transport'
import '../../activity/src/styles.css'

const deps: AppDeps = {
  clientId: 'test-client',
  discord: () => ({
    ready: async () => undefined,
    authorize: async () => 'browser-e2e-code',
    authenticate: async () => undefined
  }),
  api: createActivityApi(),
  socket: (url) => new WebSocket(url),
  now: Date.now,
  delay: browserDelay,
  random: () => 0.5
}

const root = document.getElementById('root')
if (root === null) throw new Error('Browser E2E root is missing')
createRoot(root).render(<App deps={deps} />)
