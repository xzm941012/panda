import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.jamiexiongr.panda',
  appName: 'Panda',
  webDir: '../web/dist-mobile',
  server: {
    androidScheme: 'http',
    cleartext: true,
  },
}

export default config
