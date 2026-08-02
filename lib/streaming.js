'use strict';

/**
 * Streaming actions — long-running work that reports as it goes.
 *
 * An immediate action returns an object and is done. A streaming action gets a
 * {@link StreamContext} and publishes events while it works, which is what lets
 * hc-web show a live progress bar, devices appearing one by one, and a prompt
 * like "press the button on the device now".
 *
 * Events go to `homecore/plugins/{pluginId}/commands/{requestId}/events`.
 * Six stages:
 *
 * | Stage | Meaning |
 * |---|---|
 * | `progress` | percent / label / message, as often as useful |
 * | `item` | one thing found or changed, with op add/update/remove |
 * | `warning` | recoverable — **non-terminal**, the stream continues |
 * | `awaiting_user` | a prompt; pair with {@link StreamContext#awaitRespond} |
 * | `complete` | terminal, success |
 * | `error` | terminal, failure |
 *
 * Plus `canceled`, which you emit yourself after noticing
 * {@link StreamContext#isCanceled} — only your code knows what needs rolling
 * back first.
 *
 * **Terminal stages are latched.** The first wins; a second throws. If your
 * handler returns or rejects without emitting one, the SDK synthesises an
 * `error`, so the UI is never left waiting on a stream that quietly stopped.
 *
 * @example
 * async onAction(action, params, ctx) {
 *   if (action !== 'discover') return null;
 *   const hosts = this.candidates();
 *   for (const [i, host] of hosts.entries()) {
 *     if (ctx.isCanceled()) { ctx.canceled(); return; }
 *     ctx.progress({ percent: Math.floor((100 * i) / hosts.length), message: `Probing ${host}` });
 *     const dev = await probe(host);
 *     if (dev) ctx.itemAdd({ serial: dev.serial, name: dev.name });
 *   }
 *   ctx.complete({ found: hosts.length });
 * }
 */

/** Thrown when emitting after a terminal stage has already been sent. */
class StreamTerminated extends Error {}

/** Handle passed to a streaming action handler. One per invocation. */
class StreamContext {
  constructor(plugin, requestId, actionId) {
    this._plugin = plugin;
    this.requestId = requestId;
    this.actionId = actionId;
    this.topic = `homecore/plugins/${plugin.pluginId}/commands/${requestId}/events`;
    this._terminal = false;
    this._canceled = false;
    this._responses = [];
    this._waiters = [];
  }

  // ── non-terminal stages ──────────────────────────────────────────────────

  /** Report progress. Every field is optional — send whichever you have. */
  progress({ percent = null, label = null, message = null } = {}) {
    const ev = { stage: 'progress' };
    if (percent != null) ev.percent = Math.trunc(percent);
    if (label != null) ev.label = label;
    if (message != null) ev.message = message;
    this._emit(ev, false);
  }

  /**
   * One thing was found. Include the manifest's `itemKey` field so the UI can
   * tell rows apart.
   */
  itemAdd(data) { this._emit({ stage: 'item', op: 'add', data }, false); }

  /**
   * Something already reported has changed — same `itemKey`, so the UI updates
   * that row instead of appending another.
   */
  itemUpdate(data) { this._emit({ stage: 'item', op: 'update', data }, false); }

  itemRemove(data) { this._emit({ stage: 'item', op: 'remove', data }, false); }

  /**
   * A recoverable problem. The stream continues.
   *
   * Use this for a retry or a host that did not answer. If the action cannot
   * continue, that is {@link StreamContext#error}, which is terminal.
   */
  warning(message, data = null) {
    const ev = { stage: 'warning', message };
    if (data != null) ev.data = data;
    this._emit(ev, false);
  }

  /**
   * Ask the operator for something and keep the stream open. Emit this, then
   * await {@link StreamContext#awaitRespond}.
   */
  awaitingUser(prompt, responseSchema = null) {
    const ev = { stage: 'awaiting_user', prompt };
    if (responseSchema != null) ev.response_schema = responseSchema;
    this._emit(ev, false);
  }

  // ── terminal stages ──────────────────────────────────────────────────────

  /** Terminal, success. `data` should match the manifest's `result`. */
  complete(data = {}) { this._emit({ stage: 'complete', data }, true); }

  /** Terminal, failure. For something recoverable use `warning`. */
  error(message) { this._emit({ stage: 'error', message }, true); }

  /**
   * Terminal, acknowledging a cancel. Call it yourself once `isCanceled()` is
   * true and you have unwound whatever needed unwinding — the SDK cannot know
   * when your rollback is finished.
   */
  canceled() { this._emit({ stage: 'canceled' }, true); }

  // ── cancel / respond ─────────────────────────────────────────────────────

  /** Whether a cancel has arrived. Cooperative — check it in your loop. */
  isCanceled() { return this._canceled; }

  /**
   * Resolves with the operator's answer to an `awaitingUser` prompt.
   *
   * @param {number} [timeoutMs] - Reject after this long. Omit to wait forever.
   * @returns {Promise<object>}
   */
  awaitRespond(timeoutMs = null) {
    if (this._responses.length) return Promise.resolve(this._responses.shift());
    return new Promise((resolve, reject) => {
      const waiter = { resolve, timer: null };
      if (timeoutMs != null) {
        waiter.timer = setTimeout(() => {
          const i = this._waiters.indexOf(waiter);
          if (i >= 0) this._waiters.splice(i, 1);
          reject(new Error(`no response to awaiting_user within ${timeoutMs}ms`));
        }, timeoutMs);
        // Do not hold the process open just to wait on an operator.
        if (waiter.timer.unref) waiter.timer.unref();
      }
      this._waiters.push(waiter);
    });
  }

  // ── internals, driven by PluginBase ──────────────────────────────────────

  _cancel() { this._canceled = true; }

  _deliverResponse(response) {
    const waiter = this._waiters.shift();
    if (waiter) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(response);
    } else {
      this._responses.push(response);
    }
  }

  _emit(ev, terminal) {
    if (this._terminal) {
      throw new StreamTerminated(
        `stream ${this.requestId} already terminated; cannot emit ${ev.stage}`,
      );
    }
    if (terminal) this._terminal = true;
    ev.request_id = this.requestId;
    ev.ts = new Date().toISOString();
    // Retained, so a UI that subscribes mid-action sees the latest frame
    // rather than an empty screen until the next one.
    this._plugin._publish(this.topic, JSON.stringify(ev), { qos: 1, retain: true });
  }

  /**
   * Guarantee exactly one terminal stage, then clear the retained topic.
   *
   * A handler that returns without terminating, or throws, would otherwise
   * leave the UI waiting forever on a stream that has already stopped.
   */
  _finalize(err) {
    if (!this._terminal) {
      this._terminal = true;
      this._plugin._publish(this.topic, JSON.stringify({
        stage: 'error',
        request_id: this.requestId,
        ts: new Date().toISOString(),
        message: err
          ? `plugin action failed: ${err.message || err}`
          : 'plugin dropped stream without emitting a terminal stage',
        data: { reason: 'plugin_dropped_stream' },
      }), { qos: 1, retain: true });
    }
    // An empty retained payload deletes the retained frame, so a subscriber
    // arriving later does not replay a stale terminal as if it were live.
    this._plugin._publish(this.topic, '', { qos: 1, retain: true });
  }
}

module.exports = { StreamContext, StreamTerminated };
