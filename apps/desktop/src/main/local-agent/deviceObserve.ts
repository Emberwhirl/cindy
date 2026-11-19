import { getAgentIslandService } from '../agent-island/service.js';
import { openMainWindowSession } from '../deepLink.js';
import { listDeviceObserveTasks } from '../maker-ipc/pluginObserveTasks.js';
import type { LocalAgentDeviceObserve } from './server.js';

/** Task observation for external devices; the island may start after this host, so attach lazily. */
export function desktopDeviceObserve(assertCurrent: () => void): LocalAgentDeviceObserve {
  const listeners = new Set<() => void>();
  let detach: (() => void) | undefined;
  const attach = () => {
    if (detach || !listeners.size) return;
    detach = getAgentIslandService()?.subscribeSessionActivity(() => {
      for (const listener of listeners) listener();
    });
  };
  return {
    async tasks() {
      assertCurrent();
      attach();
      const tasks = await listDeviceObserveTasks();
      assertCurrent();
      return tasks;
    },
    subscribe(listener) {
      listeners.add(listener);
      attach();
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        detach?.();
        detach = undefined;
      };
    },
    focus(sessionId, focus) {
      assertCurrent();
      openMainWindowSession(sessionId, { focus });
    },
  };
}
