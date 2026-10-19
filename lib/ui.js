'use strict';

/**
 * A plugin's own screens, carried and served by the plugin.
 *
 * The UI is a built folder — web components in one ES module, plus a
 * `manifest.json` the build writes:
 *
 *     { "host_api": 1, "entry": "index.js",
 *       "slots": [{ "slot": "plugin.page", "element": "hc-x-page" }] }
 *
 * It travels in whatever package installs the plugin, as `ui/` in the
 * plugin's package. {@link PluginBase#withUiDir} reads it, declares it on the
 * manifest with a hash of its files as its `build`, and answers homeCore's
 * `ui_file` requests from it — homeCore passes the files through to the app
 * and keeps none.
 *
 * This is the Node.js twin of `plugin_sdk_rs::ui` and must agree with it: the
 * same folder gives the same `build` in every SDK.
 *
 * @module homecore-plugin-sdk/lib/ui
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** The version of the app's `host` interface a UI is built against. */
const HOST_API = 1;

/** The slots the app knows. */
const SLOTS = Object.freeze(['plugin.page', 'device.panel']);

/** Why a folder offers no UI, or why a file can't be served. */
class UiError extends Error {}

/**
 * One place in the app a plugin's component fills.
 *
 * `slot` is `plugin.page` (its page, in place of the generic action list) or
 * `device.panel` (its devices' panel, in place of the generic controls);
 * `element` the custom element the module defines for it. For `device.panel`,
 * `deviceTypes` limits it to devices of those types — every one of the
 * plugin's devices when empty.
 */
class UiSlot {
  constructor(slot, element, deviceTypes = []) {
    this.slot = slot;
    this.element = element;
    this.deviceTypes = deviceTypes;
  }

  toJSON() {
    const out = { slot: this.slot, element: this.element };
    if (this.deviceTypes && this.deviceTypes.length > 0) out.device_types = [...this.deviceTypes];
    return out;
  }
}

/** What a plugin's UI is and where it goes — the manifest's `ui`. */
class PluginUi {
  constructor({ hostApi, version, build = '', entry = 'index.js', slots = [] }) {
    this.hostApi = hostApi;
    this.version = version;
    this.build = build;
    this.entry = entry;
    this.slots = slots;
  }

  toJSON() {
    const out = { host_api: this.hostApi, version: this.version };
    if (this.build) out.build = this.build;
    out.entry = this.entry;
    out.slots = this.slots.map((s) => s.toJSON());
    return out;
  }

  /**
   * Whether it can be offered at all: a version, a module inside the folder,
   * and at least one slot the app knows, each naming a valid custom element.
   * Slots that don't pass are dropped; `null` when none is left.
   * @returns {PluginUi|null}
   */
  validated() {
    if (
      this.version.trim() === ''
      || !relativePath(this.entry)
      || !/^[A-Za-z0-9]*$/.test(this.build)
    ) {
      return null;
    }
    const slots = this.slots.filter((s) => SLOTS.includes(s.slot) && customElement(s.element));
    if (slots.length === 0) return null;
    return new PluginUi({
      hostApi: this.hostApi, version: this.version, build: this.build, entry: this.entry, slots,
    });
  }
}

/** A custom element name: lowercase, starting with a letter, with a hyphen. */
function customElement(name) {
  return name.includes('-') && /^[a-z][a-z0-9\-._]*$/.test(name);
}

/** A path that stays inside the folder. */
function relativePath(p) {
  return p !== ''
    && !p.startsWith('/')
    && !p.includes('\\')
    && p.split('/').every((seg) => seg !== '' && seg !== '..');
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The nearest folder at or above `start` holding a `package.json`; `start` when none. */
function projectRoot(start) {
  let d = path.resolve(start);
  for (;;) {
    if (isFile(path.join(d, 'package.json'))) return d;
    const parent = path.dirname(d);
    if (parent === d) return path.resolve(start);
    d = parent;
  }
}

/**
 * Where a plugin's UI folder is.
 *
 * Pass `__dirname` of your plugin's main module (a file path works too). In
 * order:
 *
 * 1. `HC_PLUGIN_UI_DIR` when set — taken as given;
 * 2. `ui/` in that folder — how your package installs it (list `ui` in
 *    package.json `files`);
 * 3. `ui/` beside the program being run (`process.argv[1]`);
 * 4. for a plugin run from its source tree, `<project>/ui/dist`, where
 *    `<project>` is the nearest folder at or above it with a `package.json`.
 *
 * Apart from the first, a folder counts only if it holds `manifest.json`.
 *
 * @param {string} base
 * @returns {string|null}
 */
function findDir(base) {
  const env = process.env.HC_PLUGIN_UI_DIR;
  if (env) return env;
  const pkg = isDir(base) ? base : path.dirname(path.resolve(base));
  const candidates = [path.join(pkg, 'ui')];
  if (process.argv[1]) candidates.push(path.join(path.dirname(path.resolve(process.argv[1])), 'ui'));
  candidates.push(path.join(projectRoot(pkg), 'ui', 'dist'));
  return candidates.find((d) => isFile(path.join(d, 'manifest.json'))) || null;
}

const isU32 = (v) => Number.isInteger(v) && v >= 0 && v <= 0xFFFFFFFF;

function slotFrom(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new UiError('manifest.json: a slot is not an object');
  }
  const types = v.device_types === undefined ? [] : v.device_types;
  if (typeof v.slot !== 'string' || typeof v.element !== 'string') {
    throw new UiError('manifest.json: a slot needs `slot` and `element` strings');
  }
  if (!Array.isArray(types) || !types.every((t) => typeof t === 'string')) {
    throw new UiError('manifest.json: `device_types` must be a list of strings');
  }
  return new UiSlot(v.slot, v.element, [...types]);
}

/**
 * The UI in `dir`, as its manifest declares it.
 * @param {string} dir
 * @param {string} version - The plugin's version.
 * @returns {PluginUi}
 * @throws {UiError} with the reason, when there is none to offer.
 */
function load(dir, version) {
  const manifestPath = path.join(dir, 'manifest.json');
  let text;
  try {
    text = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    throw new UiError(`${manifestPath}: ${err.message}`);
  }
  let m;
  try {
    m = JSON.parse(text);
  } catch (err) {
    throw new UiError(`manifest.json: ${err.message}`);
  }
  if (!m || typeof m !== 'object' || Array.isArray(m) || !isU32(m.host_api)) {
    throw new UiError('manifest.json: `host_api` must be a whole number');
  }
  const entry = m.entry === undefined ? 'index.js' : m.entry;
  if (typeof entry !== 'string') throw new UiError('manifest.json: `entry` must be a string');
  const slotsRaw = m.slots === undefined ? [] : m.slots;
  if (!Array.isArray(slotsRaw)) throw new UiError('manifest.json: `slots` must be a list');
  const slots = slotsRaw.map(slotFrom);
  if (!isFile(path.join(dir, entry))) throw new UiError(`its entry ${entry} isn't there`);
  const ui = new PluginUi({
    hostApi: m.host_api, version, build: buildOf(dir), entry, slots,
  }).validated();
  if (!ui) throw new UiError('it declares nowhere the app can put it');
  return ui;
}

function walk(root, dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (isDir(p)) {
      walk(root, p, out);
    } else {
      out.push(path.relative(root, p).split(path.sep).join('/').replace(/\\/g, '/'));
    }
  }
}

/**
 * A hash of every file's name and contents: what changes when the UI does.
 *
 * SHA-256 over the files sorted by relative path (forward slashes), each fed
 * as its path, a 0 byte, then its contents; the first 8 bytes, in lowercase
 * hex. Identical in every homeCore SDK.
 *
 * @param {string} dir
 * @returns {string}
 */
function buildOf(dir) {
  const files = [];
  try {
    walk(dir, dir, files);
  } catch (err) {
    throw new UiError(err.message);
  }
  // Rust sorts by UTF-8 bytes; JS's default sort is by UTF-16 units, which
  // disagrees on characters outside the BMP.
  const keyed = files.map((f) => [Buffer.from(f, 'utf8'), f]);
  keyed.sort((a, b) => Buffer.compare(a[0], b[0]));
  const h = crypto.createHash('sha256');
  for (const [bytes, f] of keyed) {
    h.update(bytes);
    h.update(Buffer.from([0]));
    try {
      h.update(fs.readFileSync(path.join(dir, f)));
    } catch (err) {
      throw new UiError(err.message);
    }
  }
  return h.digest().subarray(0, 8).toString('hex');
}

/**
 * Up to `max` bytes of `file` from `offset`, and whether that is the end.
 * @param {string} dir
 * @param {string} file
 * @param {number} offset
 * @param {number} max
 * @returns {{data: Buffer, done: boolean}}
 * @throws {UiError} `no such file` for a path outside the folder or one that isn't there.
 */
function piece(dir, file, offset, max) {
  if (!relativePath(file)) throw new UiError('no such file');
  const p = path.join(dir, file);
  if (!isFile(p)) throw new UiError('no such file');
  let fd;
  try {
    fd = fs.openSync(p, 'r');
  } catch {
    throw new UiError('no such file');
  }
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.min(offset, size);
    const buf = Buffer.alloc(Math.min(max, size - start));
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, start + got);
      if (n === 0) break;
      got += n;
    }
    return { data: buf.subarray(0, got), done: offset + max >= size };
  } catch (err) {
    throw new UiError(err.message);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  HOST_API, SLOTS, UiError, UiSlot, PluginUi, findDir, load, buildOf, piece, relativePath,
};
