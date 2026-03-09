import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'net.coclaw.app',
  appName: 'CoClaw',
  webDir: 'dist',
  server: {
    url: 'https://coclaw.qidianchat.com',
    cleartext: false,
  },
};

export default config;
