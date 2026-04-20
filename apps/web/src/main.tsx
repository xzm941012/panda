import { Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createRouter,
  RouterProvider,
  createRoute,
  createRootRoute,
} from '@tanstack/react-router'
import { AppShell } from './components/layout/app-shell'
import { NodesPage } from './components/nodes/nodes-page'
import { SessionRouteBridge } from './components/sessions/session-route-bridge'
import { SessionWorkspacePage } from './components/sessions/session-workspace-page'
import { SettingsPage } from './components/settings/settings-page'
import { initializeRuntimeConfig } from './lib/runtime-config'
import { startNativeSafeAreaSync } from './lib/native-safe-area'
import {
  restorePersistedQueryCache,
  startPersistingQueryCache,
} from './lib/query-persistence'
import { applyThemeToDocument, readStoredThemeSettings } from './lib/theme'
import '../../../packages/design-tokens/src/index.css'
import './styles/base.css'
import './styles/layout.css'
import './styles/shared.css'
import './styles/nodes.css'
import './styles/details.css'
import './styles/file-preview.css'
import './styles/settings.css'
import './styles/compat.css'
import './styles/runtime-shell.css'

const queryClient = new QueryClient()

const DEV_SW_RESET_KEY = 'panda:dev-sw-reset'

const resetDevServiceWorkers = async () => {
  if (!import.meta.env.DEV || typeof window === 'undefined') {
    return
  }

  const isLocalHost =
    window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'

  if (!isLocalHost || !('serviceWorker' in navigator)) {
    return
  }

  const registrations = await navigator.serviceWorker.getRegistrations()
  const hasRegistrations = registrations.length > 0
  const hasController = Boolean(navigator.serviceWorker.controller)

  if (!hasRegistrations && !hasController) {
    window.sessionStorage.removeItem(DEV_SW_RESET_KEY)
    return
  }

  await Promise.all(registrations.map((registration) => registration.unregister()))

  if ('caches' in window) {
    const cacheKeys = await window.caches.keys()
    await Promise.all(cacheKeys.map((cacheKey) => window.caches.delete(cacheKey)))
  }

  if (!window.sessionStorage.getItem(DEV_SW_RESET_KEY)) {
    window.sessionStorage.setItem(DEV_SW_RESET_KEY, '1')
    window.location.reload()
    return
  }

  window.sessionStorage.removeItem(DEV_SW_RESET_KEY)
}

const LazyDiagnosticsPage = lazy(async () => {
  const module = await import('./components/diagnostics/diagnostics-page')
  return { default: module.DiagnosticsPage }
})

const DiagnosticsRoutePage = () => (
  <Suspense
    fallback={
      <main className="diagnostics-page">
        <div className="diagnostics-shell">
          <section className="diagnostics-card">
            <p>正在载入诊断页…</p>
          </section>
        </div>
      </main>
    }
  >
    <LazyDiagnosticsPage />
  </Suspense>
)

const rootRoute = createRootRoute({
  component: AppShell,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: SessionWorkspacePage,
})

const nodesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/nodes',
  component: NodesPage,
})

const sessionDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/session/$sessionId',
  component: SessionRouteBridge,
})

const newThreadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/new-thread/$agentId',
  component: SessionWorkspacePage,
})

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
})

const diagnosticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/diagnostics',
  component: DiagnosticsRoutePage,
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  nodesRoute,
  sessionDetailRoute,
  newThreadRoute,
  settingsRoute,
  diagnosticsRoute,
])

const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

if (typeof document !== 'undefined') {
  applyThemeToDocument(readStoredThemeSettings())
  startNativeSafeAreaSync()
}

void resetDevServiceWorkers()
  .catch(() => {})
  .then(async () => {
    await initializeRuntimeConfig()
    await restorePersistedQueryCache(queryClient)
    startPersistingQueryCache(queryClient)
  })
  .finally(() => {
    createRoot(document.getElementById('root')!).render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    )
  })
