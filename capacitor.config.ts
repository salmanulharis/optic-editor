import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Native shells for Android (APK) and iOS (IPA). They load the Vite build (dist/) from the app
 * bundle; the native projects add the COOP / COEP headers to every local response so the page is
 * cross-origin isolated (SharedArrayBuffer, threaded LibRaw) exactly like on the web.
 * Build: `npm run build && npx cap sync` (see docs/MOBILE.md).
 */
const config: CapacitorConfig = {
  appId: 'in.techbysh.optic',
  appName: 'Optic',
  webDir: 'dist',
  backgroundColor: '#1c1c1c',
  loggingBehavior: 'debug',
  server: {
    // https://localhost: a secure context (OPFS, crypto, SharedArrayBuffer once isolated).
    androidScheme: 'https',
    iosScheme: 'capacitor',
  },
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  ios: {
    // The page handles safe areas itself (viewport-fit=cover + env(safe-area-inset-*)).
    contentInset: 'never',
    scrollEnabled: false,
    limitsNavigationsToAppBoundDomains: false,
    webContentsDebuggingEnabled: false,
    preferredContentMode: 'mobile',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 3000,
      launchAutoHide: true,
      backgroundColor: '#1c1c1c',
      showSpinner: false,
      androidScaleType: 'CENTER_INSIDE',
      splashFullScreen: false,
      splashImmersive: false,
    },
    SystemBars: {
      insetsHandling: 'native',
      style: 'DARK',
    },
  },
};

export default config;
