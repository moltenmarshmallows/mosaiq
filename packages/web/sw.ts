/// <reference lib="WebWorker" />

import type { PrecacheEntry } from '@vite-pwa/workbox-swkit/precaching';
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from '@vite-pwa/workbox-swkit/precaching';
import { NavigationRoute, registerRoute } from '@vite-pwa/workbox-swkit/routing';
import './sw-push';
import './sw-offline-media';

// self.__WB_MANIFEST must stay a bare member expression — the build replaces it
// with the precache manifest via a define, which does not match through casts.
declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<PrecacheEntry | string> };

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// The prerendered "/" shell must not be served for deep links — Workbox would
// hydrate the homepage on /auth/verify and Nuxt eventually rewrites to /?token=…,
// so magic-link login never runs.  Only the bare homepage uses the fallback.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/'), {
    denylist: [/^\/(?!$)/],
  }),
);
