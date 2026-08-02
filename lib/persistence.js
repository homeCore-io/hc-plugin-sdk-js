'use strict';

/**
 * Device persistence — remembering what this plugin registered last time.
 *
 * When a device disappears from a plugin's authoritative source — a Hue bulb
 * deleted from the bridge, a Z-Wave node excluded, an entry removed from config
 * — its homeCore record has to go too. Otherwise it lingers forever, still
 * shown in the UI and still accepting commands nothing will execute.
 *
 * Working out what disappeared means knowing what existed *before*, and a
 * plugin that has just restarted knows nothing. So the SDK mirrors every
 * register/unregister to a small JSON file, loads it at startup, and gives you
 * `reconcileDevices()` to diff the live set against it.
 *
 * @example
 * onConnect() {
 *   // Once, before registering anything.
 *   this.enableDevicePersistence(path.join(configDir, '.published-device-ids.json'));
 * }
 *
 * afterASuccessfulSync(liveIds) {
 *   const report = this.reconcileDevices(liveIds);
 *   // report.staleUnregistered — gone from the bridge, now gone from homeCore
 *   // report.unknownInLive     — ids you passed but never registered
 * }
 *
 * **Only reconcile after a sync you trust.** Calling it on a partial fetch will
 * unregister live devices behind a temporarily unreachable upstream — which
 * looks exactly like the bug it exists to prevent, but worse, because the
 * devices were fine. Track an "everything succeeded" flag across your
 * per-source loop and pass the live set only when it holds.
 *
 * Plugins whose upstream reports irregularly — battery sensors that go quiet
 * for hours — should enable persistence but skip auto-reconcile. The
 * false-positive risk is worse than a zombie device, and an operator can clear
 * those with `DELETE /api/v1/plugins/{id}/devices`.
 */

const fs = require('fs');
const path = require('path');

/**
 * Insert `pluginId` into a snapshot filename.
 *
 * `.published-device-ids.json` → `.published-device-ids.plugin.hue.json`
 *
 * Real deployments keep every plugin's config in one directory, and every
 * plugin derives this path the same way — so without scoping they share one
 * file and unregister each other's devices.
 *
 * Idempotent: a path already carrying this plugin's id comes back unchanged,
 * so repeated calls cannot keep extending the name.
 *
 * Plugin ids contain dots (`plugin.hue`) and so does the base filename, so this
 * works on the whole filename rather than splitting on the extension.
 */
function scopedSnapshotPath(p, pluginId) {
  const dir = path.dirname(p);
  const name = path.basename(p);
  let scoped;
  if (name.endsWith('.json')) {
    const base = name.slice(0, -'.json'.length);
    scoped = base.endsWith(pluginId) ? name : `${base}.${pluginId}.json`;
  } else {
    scoped = name.endsWith(pluginId) ? name : `${name}.${pluginId}`;
  }
  return path.join(dir, scoped);
}

/** The set of devices this plugin has registered, optionally on disk. */
class DeviceTracker {
  constructor() {
    this._ids = new Set();
    this._path = null;
  }

  /**
   * Load any previous snapshot, then mirror every change to `p`.
   *
   * A failure to load is logged loudly and never thrown. It is not fatal — the
   * plugin still works — but it does silently cost the ability to retire
   * devices from earlier runs, so it must not pass unnoticed.
   */
  enablePersistence(p) {
    try {
      const ids = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(ids)) {
        for (const id of ids) this._ids.add(String(id));
      } else {
        console.warn(
          `[hc-sdk] device snapshot ${p} is not a list — devices registered in `
          + 'earlier runs cannot be reconciled and will linger in homeCore',
        );
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(
          `[hc-sdk] cannot read device snapshot ${p} (${err.message}) — devices `
          + 'registered in earlier runs cannot be reconciled and will linger in homeCore',
        );
      }
    }
    this._path = p;
  }

  add(deviceId) {
    if (this._ids.has(deviceId)) return;
    this._ids.add(deviceId);
    this._save();
  }

  delete(deviceId) {
    if (!this._ids.delete(deviceId)) return;
    this._save();
  }

  has(deviceId) { return this._ids.has(deviceId); }

  snapshot() { return new Set(this._ids); }

  get size() { return this._ids.size; }

  [Symbol.iterator]() { return this._ids[Symbol.iterator](); }

  _save() {
    if (!this._path) return;
    try {
      const dir = path.dirname(this._path);
      if (dir) fs.mkdirSync(dir, { recursive: true });
      const ordered = [...this._ids].sort();
      // Write to a temp file in the same directory and rename, so a crash
      // mid-write cannot leave a truncated snapshot that reads as "this plugin
      // registered nothing" and retires every device on the next reconcile.
      const tmp = `${this._path}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(ordered, null, 2));
      fs.renameSync(tmp, this._path);
    } catch (err) {
      console.warn(`[hc-sdk] device snapshot write failed (${this._path}): ${err.message}`);
    }
  }
}

module.exports = { DeviceTracker, scopedSnapshotPath };
