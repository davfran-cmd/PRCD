import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.prcd.planner',
  appName: 'PRCD.',
  webDir: 'dist',
  ios: {
    // iPad only for now; the layout adapts to landscape, portrait and Split View.
    contentInset: 'never',
    limitsNavigationsToAppBoundDomains: false,
  },
  server: {
    // Everything is bundled: no remote URL, nothing is fetched from the network.
    androidScheme: 'https',
  },
};

export default config;
