#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalAgentApiError, LocalAgentClient } from './local-agent-client.mjs';

export function formatTasks(tasks, localTime) {
  const count = tasks.length;
  const lines = [`${localTime} | ${count} ${count === 1 ? 'task' : 'tasks'}`];
  if (!count) return [...lines, '(no tasks)'].join('\n');
  return [
    ...lines,
    ...tasks.map(
      (task) =>
        `${task.status.padEnd(8)} ${task.agentKind.padEnd(11)} ${task.title} (${task.id})`,
    ),
  ].join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean' },
      discovery: { type: 'string' },
      'connection-code': { type: 'string' },
      'client-id': { type: 'string' },
      'client-name': { type: 'string' },
      json: { type: 'boolean' },
      once: { type: 'boolean' },
      focus: { type: 'string' },
      background: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'Usage: node scripts/examples/local-agent-device-observer.mjs (--discovery <file> | --connection-code <code>) [--client-id <id>] [--client-name <name>] [--json] [--once] [--focus <sessionId>] [--background]',
    );
    return;
  }
  if (Boolean(values.discovery) === Boolean(values['connection-code'])) {
    throw new LocalAgentApiError(
      'DISCOVERY_REQUIRED',
      'Pass exactly one of --discovery or --connection-code. No profiles are scanned.',
    );
  }
  const hasFocus = values.focus !== undefined;
  if (hasFocus && !values.focus) {
    throw new LocalAgentApiError(
      'OPTION_INVALID',
      '--focus requires a session ID.',
    );
  }
  if (values.background && !hasFocus) {
    throw new LocalAgentApiError(
      'OPTION_INVALID',
      '--background requires --focus.',
    );
  }

  const identity = {
    id: values['client-id'] ?? 'org.example.cindy-device-observer',
    name: values['client-name'] ?? 'Device observer example',
    version: '1.0',
  };
  const client = values['connection-code']
    ? LocalAgentClient.fromConnectionCode(values['connection-code'], identity)
    : await LocalAgentClient.discover(values.discovery, identity);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);

  try {
    console.error(
      'Approve this application in Cindy. The example does not save the connection token.',
    );
    await client.connect({ signal: controller.signal });
    const capabilities = await client.request(
      'capabilities',
      {},
      { signal: controller.signal },
    );
    const methods = Array.isArray(capabilities.methods)
      ? capabilities.methods
      : [];
    const requiredMethods = [
      'device/activity',
      ...(hasFocus ? ['device/session/focus'] : []),
    ];
    if (
      capabilities.features?.deviceObserve !== true ||
      requiredMethods.some((method) => !methods.includes(method))
    ) {
      throw new LocalAgentApiError(
        'CAPABILITY_UNSUPPORTED',
        'This host does not support the requested device task observation methods.',
      );
    }

    let cursor = 0;
    let hasSnapshot = false;
    let disabledHintPrinted = false;
    while (!controller.signal.aborted) {
      try {
        const snapshot = await client.request(
          'device/activity',
          { cursor, waitMs: 20_000 },
          { signal: controller.signal },
        );
        if (!hasSnapshot || snapshot.cursor !== cursor) {
          if (values.json) {
            console.log(
              JSON.stringify({
                cursor: snapshot.cursor,
                tasks: snapshot.tasks,
              }),
            );
          } else {
            console.log(
              formatTasks(snapshot.tasks, new Date().toLocaleTimeString()),
            );
          }
          hasSnapshot = true;
        }
        cursor = snapshot.cursor;
        if (hasFocus) {
          await client.request(
            'device/session/focus',
            { sessionId: values.focus, focus: !values.background },
            { signal: controller.signal },
          );
          return;
        }
        if (values.once) return;
      } catch (error) {
        if (controller.signal.aborted) break;
        if (
          error instanceof LocalAgentApiError &&
          error.code === 'DEVICE_OBSERVE_DISABLED'
        ) {
          if (!disabledHintPrinted) {
            console.error(
              `In Cindy Settings > Local App Connections, turn on "Allow viewing session status on this computer" for ${identity.name}.`,
            );
            disabledHintPrinted = true;
          }
          await delay(2_000, undefined, { signal: controller.signal }).catch(
            (delayError) => {
              if (!controller.signal.aborted) throw delayError;
            },
          );
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    try {
      await client.disconnect();
    } finally {
      process.removeListener('SIGINT', stop);
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`${error.code ?? 'CLIENT_FAILED'}: ${error.message}`);
    process.exitCode = 1;
  });
}
