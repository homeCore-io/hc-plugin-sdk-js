'use strict';

/**
 * Capability actions — plugin-specific commands the UI renders as buttons.
 *
 * A device command tells one device to do something. A capability action is
 * aimed at the plugin itself: "Pair the bridge", "Rescan the network", "Forget
 * devices that no longer answer". Declaring one is all it takes for it to
 * appear as a button on the plugin's page in hc-web and to become callable from
 * hc-mcp — neither needs code written for your plugin specifically.
 *
 * Two kinds:
 *
 * - **Immediate** (`stream: false`) — your handler returns an object and that
 *   is the result. For anything that finishes in a moment.
 * - **Streaming** (`stream: true`) — your handler gets a `StreamContext` and
 *   reports progress, items, warnings, and a terminal result as it goes. For a
 *   network sweep, a pairing flow, or anything long enough that a spinner would
 *   be a lie.
 *
 * @example
 * const { Action, Capabilities } = require('homecore-plugin-sdk');
 *
 * new Capabilities([
 *   new Action({
 *     id: 'discover',
 *     label: 'Discover devices',
 *     description: 'Sweep the local network and register what answers.',
 *     stream: true,
 *     cancelable: true,
 *     itemKey: 'serial',
 *     timeoutMs: 30000,
 *   }),
 * ]);
 */

/** Whether a second invocation may start while the first is running. */
const Concurrency = Object.freeze({
  /** May run concurrently with itself. */
  MULTI: 'multi',
  /** A second invocation is rejected with `busy` and the active request id. */
  SINGLE: 'single',
});

/**
 * The least-privileged role allowed to invoke an action.
 *
 * homeCore enforces this; it is not a UI hint. Use ADMIN for anything
 * destructive — unregistering devices, clearing pairings, factory resets.
 */
const RequiresRole = Object.freeze({
  ADMIN: 'admin',
  USER: 'user',
  READ_ONLY: 'read_only',
});

/** Item operations a streaming action may emit, if it emits items at all. */
const ItemOp = Object.freeze({
  ADD: 'add',
  UPDATE: 'update',
  REMOVE: 'remove',
});

/** One declared action. */
class Action {
  /**
   * @param {object} opts
   * @param {string} opts.id       - Stable id. Arrives as `action`, and is what
   *                                 your handler dispatches on.
   * @param {string} opts.label    - What the button says.
   * @param {string} [opts.description] - Shown next to the button. Say what it
   *                                 will do, and to what — an operator is
   *                                 deciding whether to press it.
   * @param {object} [opts.params] - JSON Schema for the parameters. Omit and
   *                                 the UI renders a plain button, not a form.
   * @param {object} [opts.result] - JSON Schema of the result, for display.
   * @param {boolean} [opts.stream=false]     - Handler takes a StreamContext.
   * @param {boolean} [opts.cancelable=false] - The stream honours cancel. Only
   *                                 claim it if you actually check.
   * @param {string} [opts.concurrency] - See {@link Concurrency}.
   * @param {string} [opts.itemKey] - For a streaming action that emits items,
   *                                 the field identifying each one, so the UI
   *                                 updates a row rather than appending.
   * @param {string[]} [opts.itemOperations] - Which of add/update/remove it emits.
   * @param {string} [opts.requiresRole] - See {@link RequiresRole}.
   * @param {number} [opts.timeoutMs] - How long homeCore waits before giving
   *                                 up. Set it above the realistic worst case;
   *                                 the default window is short.
   */
  constructor({
    id,
    label,
    description = null,
    params = null,
    result = null,
    stream = false,
    cancelable = false,
    concurrency = Concurrency.MULTI,
    itemKey = null,
    itemOperations = null,
    requiresRole = RequiresRole.USER,
    timeoutMs = null,
  } = {}) {
    if (!id) throw new Error('Action requires an id');
    if (!label) throw new Error(`Action ${id} requires a label`);
    Object.assign(this, {
      id, label, description, params, result, stream, cancelable,
      concurrency, itemKey, itemOperations, requiresRole, timeoutMs,
    });
  }

  toJSON() {
    const out = {
      id: this.id,
      label: this.label,
      stream: this.stream,
      cancelable: this.cancelable,
      concurrency: this.concurrency,
      requires_role: this.requiresRole,
    };
    // Absent optionals are omitted rather than sent as null, so this manifest
    // is byte-comparable with the Rust SDK's.
    if (this.description != null) out.description = this.description;
    if (this.params != null) out.params = this.params;
    if (this.result != null) out.result = this.result;
    if (this.itemKey != null) out.item_key = this.itemKey;
    if (this.itemOperations != null) out.item_operations = this.itemOperations;
    if (this.timeoutMs != null) out.timeout_ms = this.timeoutMs;
    return out;
  }
}

/**
 * The manifest: everything this plugin declares about itself.
 *
 * `pluginId` is filled in by the SDK — it has to match the MQTT client id and
 * there is no reason to say it twice.
 */
class Capabilities {
  /**
   * @param {Action[]} [actions]
   * @param {object} [opts]
   * @param {object} [opts.configSchema] - JSON Schema for the plugin's own
   *   config file. When present, hc-web renders a typed settings form instead
   *   of a raw text box. See `onSetConfig` — a plugin that declares this will
   *   receive structured config, not a string.
   * @param {object} [opts.configDescriptor] - A plugin-authored field
   *   descriptor. Takes precedence over configSchema for rendering.
   */
  constructor(actions = [], { configSchema = null, configDescriptor = null } = {}) {
    this.actions = actions;
    this.configSchema = configSchema;
    this.configDescriptor = configDescriptor;
    this.spec = '1';
    this.pluginId = '';
  }

  toJSON() {
    const out = {
      spec: this.spec,
      plugin_id: this.pluginId,
      actions: this.actions.map((a) => a.toJSON()),
    };
    // These ride on the manifest rather than a topic of their own; core
    // extracts them from this payload.
    if (this.configSchema != null) out.config_schema = this.configSchema;
    if (this.configDescriptor != null) out.config_descriptor = this.configDescriptor;
    return out;
  }
}

module.exports = { Action, Capabilities, Concurrency, ItemOp, RequiresRole };
