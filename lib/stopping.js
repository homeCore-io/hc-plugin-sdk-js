'use strict';

/**
 * A stopped plugin says so before it goes.
 *
 * SIGTERM is how homeCore and a plugin runtime stop a plugin, and homeCore
 * kills it 2 seconds later. Node's default ends the process on the spot, so
 * every device kept reading online with its last state. Once a plugin runs,
 * SIGTERM and Ctrl-C call its stop() (its onStop hook, every device offline,
 * the plugin offline, a disconnect) and then exit.
 */

/** How long a plugin's onStop may take: the goodbye still has to go out. */
const HOOK_LIMIT_MS = 1000;

/** From the signal to exiting, whatever happens: inside homeCore's 2 seconds. */
const DEADLINE_MS = 1800;

const running = new Set();
let installed = false;

/**
 * Wait for `promise`, but no longer than `ms`. True when it settled in time.
 *
 * @param {Promise<unknown>} promise
 * @param {number} ms
 * @returns {Promise<boolean>}
 */
function within(promise, ms) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  return Promise.race([promise.then(() => true, () => true), late]).finally(() =>
    clearTimeout(timer),
  );
}

async function stopAll() {
  const deadline = setTimeout(() => process.exit(0), DEADLINE_MS);
  await Promise.all([...running].map((plugin) => plugin.stop()));
  clearTimeout(deadline);
  process.exit(0);
}

/**
 * Stop `plugin` on SIGTERM or Ctrl-C. The signals are watched once per process.
 *
 * @param {{ stop: () => Promise<void> }} plugin
 */
function watch(plugin) {
  running.add(plugin);
  if (installed) return;
  installed = true;
  process.once('SIGTERM', stopAll);
  process.once('SIGINT', stopAll);
}

/** @param {object} plugin */
function forget(plugin) {
  running.delete(plugin);
}

module.exports = { HOOK_LIMIT_MS, DEADLINE_MS, within, watch, forget };
