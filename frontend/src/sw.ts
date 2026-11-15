/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { runSync } from './features/sync/engine';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: { url: string; revision: string | null }[];
};
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
clientsClaim();
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//] }),
);
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});
self.addEventListener('sync', ((event: ExtendableEvent & { tag: string }) => {
  if (event.tag === 'doris-ledger-sync')
    event.waitUntil(
      runSync({ force: true }).then((result) => {
        if (result === 'retry' || result === 'busy')
          throw new Error('Queued records still need a backup retry.');
      }),
    );
}) as EventListener);
