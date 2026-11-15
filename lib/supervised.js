'use strict';

/**
 * A plugin homeCore started goes when homeCore does.
 *
 * Core sets HOMECORE_SUPERVISED to its own process id on every plugin it
 * starts. Core stopped the usual way stops its plugins first. Core killed or
 * crashed leaves them running, and the next core starts a second copy of each
 * under the same broker id; the two knock each other off the broker every few
 * seconds for as long as both run. So a plugin whose parent was core, and is
 * no longer, stops.
 *
 * A plugin started any other way (by hand, by systemd, in its own container)
 * has no such variable and is left alone. One started by core through another
 * process, a launcher script that doesn't `exec`, has a parent that isn't
 * core, and is left alone too, rather than stopped by mistake.
 */

const SUPERVISED_ENV = 'HOMECORE_SUPERVISED';
const EVERY_MS = 2000;

let started = false;

/**
 * Core's id when core is the parent and so worth watching, else null.
 *
 * @param {string|undefined} value
 * @param {number} parent
 * @returns {number|null}
 */
function decide(value, parent) {
  const core = Number((value ?? '').trim());
  return Number.isInteger(core) && core > 0 && core === parent ? core : null;
}

/**
 * Start watching, once per process, if core is the parent.
 *
 * @param {string} pluginId
 * @param {{ info?: Function, warn?: Function }} [log]
 */
function watch(pluginId, log = console) {
  if (started || process.platform === 'win32') return;
  started = true;
  const value = process.env[SUPERVISED_ENV];
  const core = decide(value, process.ppid);
  if (core === null) {
    if (value !== undefined) {
      log.info?.(
        `${pluginId}: started by homeCore through another process, so not watching for homeCore stopping`,
      );
    }
    return;
  }
  const timer = setInterval(() => {
    if (process.ppid === core) return;
    // Its output went to core, which is gone: writing may fail, and mustn't
    // keep the plugin from stopping.
    try {
      log.warn?.(
        `${pluginId}: homeCore (pid ${core}), which started this plugin, has stopped; stopping too, so the next homeCore's copy runs alone`,
      );
    } catch {
      // nothing to tell, and no one to tell it to
    }
    process.exit(0);
  }, EVERY_MS);
  // The watch alone never keeps a plugin running.
  timer.unref();
}

module.exports = { SUPERVISED_ENV, decide, watch };
