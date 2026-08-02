'use strict';

/**
 * Notices — a plugin's own account of what is wrong with it.
 *
 * A plugin's status answers "is the process alive": active, offline, stopped.
 * It cannot answer "alive, but structurally unable to do its job", and that is
 * the state operators actually get stuck in. A plugin whose receiver is bound
 * to the wrong interface starts cleanly, heartbeats, reports active, and
 * silently drops everything. On the dashboard it reads as healthy.
 *
 * A notice carries the diagnosis to the UI, where it appears on the plugin's
 * card rather than only in a log stream nobody is reading.
 *
 * Notices are **current state, not an event log**. The full set rides on every
 * heartbeat and homeCore replaces what it held, so a cleared condition
 * disappears on its own — nothing to acknowledge, nothing to expire.
 *
 * The trap is raising once at startup and never looking again: a plugin that
 * reports `no_devices_configured` at boot is still showing it after the
 * operator has added devices. Re-derive conditions where you already loop.
 *
 * @example
 * const { PluginNotice } = require('homecore-plugin-sdk');
 *
 * if (!this.reachable) {
 *   this.notices.raise(PluginNotice.error(
 *     'bridge_unreachable',
 *     'The bridge stopped answering, so no device state is updating.',
 *     { remedy: 'Check that the bridge is powered on and on this network.' },
 *   ));
 * } else {
 *   this.notices.clear('bridge_unreachable');
 * }
 */

/** How much the operator should care. */
const NoticeLevel = Object.freeze({
  /** Worth knowing, nothing is wrong — a deliberate non-default mode, say. */
  INFO: 'info',
  /** Runs, but something it needs is missing and some function is unavailable. */
  WARNING: 'warning',
  /** Cannot do its job at all; operator action required. */
  ERROR: 'error',
});

/** One condition a plugin is reporting about itself. */
class PluginNotice {
  /**
   * @param {string} level   - One of {@link NoticeLevel}.
   * @param {string} code    - Stable snake_case id. The UI keys off this, so
   *                           `message` stays free to be reworded.
   * @param {string} message - What is wrong, in a sentence an operator can act on.
   * @param {object} [opts]
   * @param {string} [opts.remedy] - What to do about it, when it can be stated
   *                                 concretely. Omit rather than guess.
   */
  constructor(level, code, message, { remedy = null } = {}) {
    this.level = level;
    this.code = code;
    this.message = message;
    this.remedy = remedy;
  }

  static info(code, message, opts) {
    return new PluginNotice(NoticeLevel.INFO, code, message, opts);
  }

  static warning(code, message, opts) {
    return new PluginNotice(NoticeLevel.WARNING, code, message, opts);
  }

  static error(code, message, opts) {
    return new PluginNotice(NoticeLevel.ERROR, code, message, opts);
  }

  /** The wire form. `remedy` is omitted when unset, matching the Rust SDK. */
  toJSON() {
    const out = { level: this.level, code: this.code, message: this.message };
    if (this.remedy != null) out.remedy = this.remedy;
    return out;
  }
}

/**
 * The set of notices a plugin is currently reporting.
 *
 * Obtain one as `this.notices` on `PluginBase`.
 */
class PluginNotices {
  /**
   * @param {function} [onChange] - Called when the set actually changes, so the
   *   plugin can push a heartbeat immediately. Notices ride on the heartbeat,
   *   so without this a condition raised at startup would not reach the UI
   *   until the next beat — up to a minute of the operator seeing nothing.
   */
  constructor(onChange = null) {
    this._notices = new Map();
    this._onChange = onChange;
  }

  /**
   * Add or replace the notice with this code. Re-raising overwrites, so
   * re-deriving conditions on a poll loop is the intended usage.
   */
  raise(notice) {
    const before = this._notices.get(notice.code);
    this._notices.set(notice.code, notice);
    this._notify(!_same(before, notice));
  }

  /** Drop a notice. A no-op if it is not raised, so no need to check first. */
  clear(code) {
    this._notify(this._notices.delete(code));
  }

  /**
   * Replace the whole set at once.
   *
   * The right call when a sync cycle re-derives every condition together — it
   * cannot leave a stale notice behind the way scattered raise/clear pairs can.
   */
  set(notices) {
    const next = new Map(notices.map((n) => [n.code, n]));
    let changed = next.size !== this._notices.size;
    if (!changed) {
      for (const [code, n] of next) {
        if (!_same(this._notices.get(code), n)) { changed = true; break; }
      }
    }
    this._notices = next;
    this._notify(changed);
  }

  clearAll() {
    const changed = this._notices.size > 0;
    this._notices.clear();
    this._notify(changed);
  }

  /** What the next heartbeat will carry. */
  snapshot() {
    return [...this._notices.values()];
  }

  toWire() {
    return this.snapshot().map((n) => n.toJSON());
  }

  has(code) {
    return this._notices.has(code);
  }

  get size() {
    return this._notices.size;
  }

  _notify(changed) {
    // Re-deriving the same conditions must not cost a publish.
    if (changed && this._onChange) this._onChange();
  }
}

function _same(a, b) {
  if (!a || !b) return false;
  return a.level === b.level && a.message === b.message && a.remedy === b.remedy;
}

module.exports = { NoticeLevel, PluginNotice, PluginNotices };
