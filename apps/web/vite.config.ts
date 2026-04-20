import { defineConfig, type Plugin, type PreviewServer, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import qrcode from 'qrcode-terminal'

const normalizeUrl = (value: string | null | undefined) => {
  const normalized = value?.trim() ?? ''
  return normalized ? normalized.replace(/\/+$/, '') : null
}

const pickPreferredUrl = (urls: string[]) => {
  const normalizedUrls = urls
    .map((value) => normalizeUrl(value))
    .filter((value): value is string => Boolean(value))

  return (
    normalizedUrls.find((value) => value.includes('.ts.net')) ??
    normalizedUrls.find((value) => value.includes('://100.')) ??
    normalizedUrls.find(
      (value) => !value.includes('://127.0.0.1') && !value.includes('://localhost'),
    ) ??
    normalizedUrls[0] ??
    null
  )
}

const printQrForUrl = (label: string, url: string | null) => {
  if (!url) {
    return
  }

  console.log(`\n${label}\n${url}`)
  qrcode.generate(url, { small: true }, (rendered) => {
    const content = rendered?.trim()
    if (content) {
      console.log(`\n${content}`)
    }
  })
}

const terminalQrPlugin = (): Plugin => {
  let printedDev = false
  let printedPreview = false

  const attachPrinter = (
    server: ViteDevServer | PreviewServer,
    mode: 'dev' | 'preview',
  ) => {
    server.httpServer?.once('listening', () => {
      if (mode === 'dev' && printedDev) {
        return
      }

      if (mode === 'preview' && printedPreview) {
        return
      }

      if (mode === 'dev') {
        printedDev = true
      } else {
        printedPreview = true
      }

      const url = pickPreferredUrl([
        ...(server.resolvedUrls?.network ?? []),
        ...(server.resolvedUrls?.local ?? []),
      ])
      printQrForUrl(
        mode === 'dev'
          ? 'Panda web is ready. Scan this QR code on your phone:'
          : 'Panda web preview is ready. Scan this QR code on your phone:',
        url,
      )
    })
  }

  return {
    name: 'panda-terminal-qr',
    configureServer(server) {
      attachPrinter(server, 'dev')
    },
    configurePreviewServer(server) {
      attachPrinter(server, 'preview')
    },
  }
}

export default defineConfig(({ command, mode }) => {
  const isMobileBuild = mode === 'mobile'

  return {
    build: {
      outDir: isMobileBuild ? 'dist-mobile' : 'dist',
    },
    plugins: [
      react(),
      terminalQrPlugin(),
      ...(command === 'build' && !isMobileBuild
        ? [
            VitePWA({
            registerType: 'autoUpdate',
            strategies: 'injectManifest',
            srcDir: 'src',
            filename: 'sw.ts',
            includeAssets: [
              'icon.svg',
              'small-icon.svg',
              'logo.png',
              'apple-touch-icon.png',
              'pwa-192.png',
              'pwa-512.png',
              'maskable-512.png',
            ],
            manifest: {
              id: '/',
              name: 'Panda',
              short_name: 'Panda',
              description: 'Mobile-first remote control for local AI coding agents.',
              theme_color: '#12100e',
              background_color: '#12100e',
              display: 'standalone',
              scope: '/',
              start_url: '/',
              icons: [
                {
                  src: '/pwa-192.png',
                  sizes: '192x192',
                  type: 'image/png',
                  purpose: 'any',
                },
                {
                  src: '/pwa-512.png',
                  sizes: '512x512',
                  type: 'image/png',
                  purpose: 'any',
                },
                {
                  src: '/maskable-512.png',
                  sizes: '512x512',
                  type: 'image/png',
                  purpose: 'maskable',
                },
              ],
            },
            }),
          ]
        : []),
    ],
    server: {
      allowedHosts: ['.ts.net'],
      port: 4173,
    },
    preview: {
      port: 4174,
    },
  }
})
