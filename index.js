'use strict';

/**
 * homecore-plugin-sdk — Node.js SDK for HomeCore device plugins.
 *
 * @example
 * const { PluginBase } = require('homecore-plugin-sdk');
 *
 * class MyLightPlugin extends PluginBase {
 *   constructor() {
 *     super({ pluginId: 'plugin.my_light' });
 *   }
 *
 *   onCommand(deviceId, payload) {
 *     console.log(`Command for ${deviceId}:`, payload);
 *     this.publishState(deviceId, { on: payload.on ?? false });
 *   }
 *
 *   onConnect() {
 *     this.registerDevice('light.01', 'My Light', {
 *       on: { type: 'boolean' },
 *       brightness: { type: 'integer', minimum: 0, maximum: 255 },
 *     });
 *   }
 * }
 *
 * new MyLightPlugin().run();
 */

const mqtt = require('mqtt');
const fs = require('fs');

const { NoticeLevel, PluginNotice, PluginNotices } = require('./lib/notices');
const {
  Action, Capabilities, Concurrency, ItemOp, RequiresRole,
} = require('./lib/capabilities');
const { StreamContext, StreamTerminated } = require('./lib/streaming');
const { DeviceTracker, scopedSnapshotPath } = require('./lib/persistence');

/**
 * This SDK's version, reported in every heartbeat. Informational — it tells an
 * operator which SDK to rebuild against; it is not what core checks
 * compatibility on.
 */
const SDK_VERSION = '0.2.0';

/**
 * The wire protocol this SDK speaks, which is core's hc-types version. Core
 * compares it against its own to decide whether the two agree on the shape of
 * a device, an event, and a command.
 */
const PROTOCOL_VERSION = '0.1.5';

/**
 * Base class for HomeCore plugins written in Node.js.
 *
 * Subclasses must override {@link PluginBase#onCommand} and optionally
 * {@link PluginBase#onConnect}.  Call {@link PluginBase#run} to connect.
 */
class PluginBase {
  /**
   * @param {object} options
   * @param {string} options.pluginId     - Unique plugin identifier.
   * @param {string} [options.brokerHost] - MQTT broker host (default: 127.0.0.1).
   * @param {number} [options.brokerPort] - MQTT broker port (default: 1883).
   * @param {string} [options.password]   - MQTT password for this plugin.
   */
  constructor({
    pluginId,
    brokerHost = process.env.HC_BROKER_HOST || '127.0.0.1',
    brokerPort = parseInt(process.env.HC_BROKER_PORT || '1883', 10),
    password   = process.env.HC_PLUGIN_PASSWORD || '',
  } = {}) {
    if (!pluginId) throw new Error('pluginId is required');
    this.pluginId   = pluginId;
    this.brokerHost = brokerHost;
    this.brokerPort = brokerPort;
    this.password   = password;
    /** @type {import('mqtt').MqttClient|null} */
    this._client = null;
    this._startedAt = Date.now();
    this._managementEnabled = false;
    this._configPath = null;
    this._version = null;
    this._heartbeatTimer = null;
    this._logForwardEnabled = false;
    this._logForwardLevel = 'info';
    this._logLevel = null;

    /**
     * Conditions this plugin is currently reporting about itself. Raised and
     * cleared by your code, republished in full on every heartbeat.
     * @type {PluginNotices}
     */
    this.notices = new PluginNotices(() => this._onNoticesChanged());

    // Devices this plugin has registered. Drives the heartbeat's device_count,
    // decides which command topics we subscribe to, and — once persistence is
    // enabled — survives a restart so reconcileDevices can tell what has since
    // disappeared.
    this._devices = new DeviceTracker();
    this._capabilities = null;
    this._activeStreams = new Map();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Publish a device state update (retained, QoS 1).
   *
   * @param {string} deviceId - Canonical HomeCore device identifier.
   * @param {object} state    - Attribute map to publish.
   * @param {object} [options] - Optional publish metadata.
   * @param {object} [options.change] - `_hc.change` payload describing provenance.
   */
  publishState(deviceId, state, options = {}) {
    const topic   = `homecore/devices/${deviceId}/state`;
    const payload = JSON.stringify(this._withStateChangeMetadata(state, options.change));
    this._publish(topic, payload, { retain: true, qos: 1 });
  }

  /**
   * Publish a device registration payload.
   *
   * @param {string} deviceId       - Stable unique device identifier.
   * @param {string} name           - Human-readable label.
   * @param {object} capabilities   - JSON Schema object for device attributes.
   * @param {string|null} [area]    - Optional room/zone assignment.
   */
  registerDevice(deviceId, name, capabilities, area = null) {
    const topic   = `homecore/plugins/${this.pluginId}/register`;
    const payload = JSON.stringify({ device_id: deviceId, plugin_id: this.pluginId, name, area, capabilities });
    this._publish(topic, payload, { qos: 1 });
    this._trackDevice(deviceId);
  }

  /**
   * Register a device by type name.
   *
   * Instead of providing a full capability schema, supply a `deviceType` string
   * that HomeCore resolves against its built-in device-type catalog.  This is the
   * recommended registration path for well-known device categories.
   *
   * Example types: `"light"`, `"switch"`, `"motion_sensor"`, `"contact_sensor"`,
   * `"temperature_sensor"`, `"power_monitor"`, `"cover"`, `"lock"`,
   * `"climate"`, `"virtual_switch"`, …
   *
   * @param {string}      deviceId   - Stable unique device identifier.
   * @param {string}      name       - Human-readable label.
   * @param {string}      deviceType - Type name from the device-type catalog.
   * @param {string|null} [area]     - Optional room/zone assignment.
   */
  registerDeviceTyped(deviceId, name, deviceType, area = null) {
    const topic   = `homecore/plugins/${this.pluginId}/register`;
    const payload = JSON.stringify({ device_id: deviceId, plugin_id: this.pluginId, name, area, device_type: deviceType });
    this._publish(topic, payload, { qos: 1 });
    this._trackDevice(deviceId);
  }

  /**
   * Retire a device from HomeCore by clearing retained topics and publishing
   * a plugin-scoped unregister message.
   *
   * @param {string} deviceId - Stable unique device identifier.
   */
  unregisterDevice(deviceId) {
    this._publish(`homecore/devices/${deviceId}/state`, '', { retain: true, qos: 1 });
    this._publish(`homecore/devices/${deviceId}/availability`, '', { retain: true, qos: 1 });
    this._publish(`homecore/devices/${deviceId}/schema`, '', { retain: true, qos: 1 });
    const topic = `homecore/plugins/${this.pluginId}/unregister`;
    const payload = JSON.stringify({ device_id: deviceId });
    this._publish(topic, payload, { qos: 1 });
    this.unsubscribeCommands(deviceId);
    this._devices.delete(deviceId);
  }

  /**
   * Receive commands for one device.
   *
   * Every `registerDevice*` call does this for you, so you rarely need it.
   * Reach for it only when homeCore knows about a device this plugin did not
   * register.
   *
   * @param {string} deviceId
   */
  subscribeCommands(deviceId) {
    this._trackDevice(deviceId);
  }

  /** Stop receiving commands for one device. */
  unsubscribeCommands(deviceId) {
    if (this._client) this._client.unsubscribe(`homecore/devices/${deviceId}/cmd`);
  }

  /**
   * Remember across restarts which devices this plugin registered.
   *
   * Call once at startup, before registering anything. The plugin id is
   * inserted into the filename, so plugins sharing a config directory cannot
   * share a snapshot and retire each other's devices.
   *
   * Without this, {@link PluginBase#reconcileDevices} can only see devices
   * registered in the *current* process, so anything dropped while the plugin
   * was down lingers in homeCore forever.
   *
   * @param {string} p - Typically `<configDir>/.published-device-ids.json`.
   */
  enableDevicePersistence(p) {
    this._devices.enablePersistence(scopedSnapshotPath(p, this.pluginId));
  }

  /**
   * Unregister every device this plugin knows about that is not in `live`.
   *
   * The "set what is live this cycle, let the SDK clean up the rest" workflow.
   * Combined with {@link PluginBase#enableDevicePersistence} it also retires
   * devices registered in earlier runs.
   *
   * **Only call this after a sync you trust.** On a partial fetch it will
   * unregister live devices behind a temporarily unreachable upstream. Track an
   * "everything succeeded" flag across your per-source loop and pass the live
   * set only when it holds.
   *
   * Ids in `live` that were never registered are reported in `unknownInLive`
   * and otherwise ignored — register them first if you meant to keep them.
   *
   * @param {Iterable<string>} live
   * @returns {{staleUnregistered: string[], unknownInLive: string[]}}
   */
  reconcileDevices(live) {
    const liveSet = live instanceof Set ? live : new Set(live);
    const known = this._devices.snapshot();
    const stale = [...known].filter((id) => !liveSet.has(id)).sort();
    const unknownInLive = [...liveSet].filter((id) => !known.has(id)).sort();

    const staleUnregistered = [];
    for (const deviceId of stale) {
      try {
        this.unregisterDevice(deviceId);
        staleUnregistered.push(deviceId);
      } catch (err) {
        // One failure must not stop the rest.
        console.warn(`[${this.pluginId}] failed to unregister stale device ${deviceId}: ${err.message}`);
      }
    }
    return { staleUnregistered, unknownInLive };
  }

  /**
   * Receive *state* updates for a device this plugin does not own.
   *
   * For cross-device consumers — a thermostat reading sensors that belong to
   * other plugins. Updates arrive on {@link PluginBase#onState}.
   *
   * The broker ACL has to allow it: such a plugin needs
   * `allow_sub = ["homecore/devices/+/state"]`, broader than a typical plugin's.
   *
   * @param {string} deviceId
   */
  subscribeState(deviceId) {
    if (this._client) this._client.subscribe(`homecore/devices/${deviceId}/state`, { qos: 1 });
  }

  /** Stop receiving state for a device. */
  unsubscribeState(deviceId) {
    if (this._client) this._client.unsubscribe(`homecore/devices/${deviceId}/state`);
  }

  /**
   * Publish a partial state update (JSON merge-patch, QoS 1, not retained).
   *
   * Use this for high-frequency sensors that send diffs rather than full state.
   *
   * @param {string} deviceId - Canonical HomeCore device identifier.
   * @param {object} patch    - Attributes to merge into the current state.
   * @param {object} [options] - Optional publish metadata.
   * @param {object} [options.change] - `_hc.change` payload describing provenance.
   */
  publishStatePartial(deviceId, patch, options = {}) {
    const topic   = `homecore/devices/${deviceId}/state/partial`;
    const payload = JSON.stringify(this._withStateChangeMetadata(patch, options.change));
    this._publish(topic, payload, { retain: false, qos: 1 });
  }

  /**
   * Publish a state update that is the direct result of a HomeCore command.
   *
   * This preserves `_hc.command` metadata as `_hc.change` so rules can tell the
   * resulting state update came from HomeCore.
   *
   * @param {string} deviceId - Canonical HomeCore device identifier.
   * @param {object} state - Attribute map to publish.
   * @param {object} commandPayload - Original HomeCore command payload.
   * @param {string} [fallbackSource] - Source label if the command had no metadata.
   */
  publishStateForCommand(deviceId, state, commandPayload, fallbackSource = this.pluginId) {
    this.publishState(deviceId, state, {
      change: this.changeFromCommand(commandPayload, fallbackSource),
    });
  }

  /**
   * Publish a partial state update that is the direct result of a HomeCore command.
   *
   * @param {string} deviceId - Canonical HomeCore device identifier.
   * @param {object} patch - Merge-patch payload to publish.
   * @param {object} commandPayload - Original HomeCore command payload.
   * @param {string} [fallbackSource] - Source label if the command had no metadata.
   */
  publishStatePartialForCommand(deviceId, patch, commandPayload, fallbackSource = this.pluginId) {
    this.publishStatePartial(deviceId, patch, {
      change: this.changeFromCommand(commandPayload, fallbackSource),
    });
  }

  /**
   * Publish an availability heartbeat (retained, QoS 1).
   *
   * @param {string}  deviceId  - Target device.
   * @param {boolean} available - `true` for online, `false` for offline.
   */
  publishAvailability(deviceId, available) {
    const topic   = `homecore/devices/${deviceId}/availability`;
    const payload = available ? 'online' : 'offline';
    this._publish(topic, payload, { retain: true, qos: 1 });
  }

  /**
   * Publish plugin status to ``homecore/plugins/{pluginId}/status`` (retained).
   *
   * @param {string} status - One of ``"active"``, ``"degraded"``, ``"offline"``.
   */
  publishPluginStatus(status) {
    const topic = `homecore/plugins/${this.pluginId}/status`;
    this._publish(topic, status, { retain: true, qos: 1 });
  }

  /**
   * Register a device with all optional fields.
   *
   * @param {string} deviceId        - Stable unique device identifier.
   * @param {string} name            - Human-readable label.
   * @param {object} [opts]          - Optional registration fields.
   * @param {string} [opts.deviceType]    - Type name from the device-type catalog.
   * @param {string} [opts.area]          - Room/zone assignment.
   * @param {object} [opts.capabilities]  - JSON Schema object for device attributes.
   */
  registerDeviceFull(deviceId, name, { deviceType, area, capabilities } = {}) {
    const topic = `homecore/plugins/${this.pluginId}/register`;
    const msg = { device_id: deviceId, plugin_id: this.pluginId, name };
    if (deviceType !== undefined) msg.device_type = deviceType;
    if (area !== undefined) msg.area = area;
    if (capabilities !== undefined) msg.capabilities = capabilities;
    this._publish(topic, JSON.stringify(msg), { qos: 1 });
    this._trackDevice(deviceId);
  }

  /**
   * Publish a device capability schema (retained, QoS 1).
   *
   * @param {string} deviceId - Canonical HomeCore device identifier.
   * @param {object} schema   - Capability schema object.
   */
  registerDeviceSchema(deviceId, schema) {
    const topic = `homecore/devices/${deviceId}/schema`;
    this._publish(topic, JSON.stringify(schema), { retain: true, qos: 1 });
  }

  /**
   * Publish a structured event (QoS 1, not retained).
   *
   * @param {string} eventType - Event type identifier.
   * @param {object} payload   - Event payload.
   */
  publishEvent(eventType, payload) {
    const topic = `homecore/events/${eventType}`;
    this._publish(topic, JSON.stringify(payload), { qos: 1 });
  }

  /**
   * Enable the management protocol (heartbeat + command handling).
   *
   * @param {object} [opts]
   * @param {number} [opts.intervalSecs=60] - Heartbeat interval in seconds.
   * @param {string|null} [opts.version=null] - Plugin version string.
   * @param {string|null} [opts.configPath=null] - Path to config file for get/set_config.
   */
  enableManagement({
    intervalSecs = 60, version = null, configPath = null, capabilities = null,
  } = {}) {
    this._managementEnabled = true;
    this._version = version;
    this._configPath = configPath;
    if (capabilities) {
      capabilities.pluginId = this.pluginId;
      this._capabilities = capabilities;
    }

    if (this._client) {
      this._client.subscribe(`homecore/plugins/${this.pluginId}/manage/cmd`, { qos: 1 });
    }
    this._publishCapabilities();

    this._heartbeatTimer = setInterval(
      () => this._publishHeartbeat(),
      intervalSecs * 1000,
    );
    // Do not hold the process open on the heartbeat alone.
    if (this._heartbeatTimer.unref) this._heartbeatTimer.unref();
    this._publishHeartbeat();
  }

  /** Publish one heartbeat now. */
  _publishHeartbeat() {
    this._publish(
      `homecore/plugins/${this.pluginId}/heartbeat`,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        version: this._version,
        sdk_version: SDK_VERSION,
        protocol_version: PROTOCOL_VERSION,
        uptime_secs: Math.floor((Date.now() - this._startedAt) / 1000),
        device_count: this._devices.size,
        // Full current set every beat. Core replaces rather than merges, so a
        // cleared condition disappears on its own and nothing expires.
        notices: this.notices.toWire(),
      }),
      { qos: 1 },
    );
  }

  /**
   * Publish the action manifest, retained.
   *
   * Retained because homeCore may start, or restart, after this plugin —
   * otherwise a late-joining core never learns the plugin has actions.
   */
  _publishCapabilities() {
    if (!this._capabilities) return;
    this._capabilities.pluginId = this.pluginId;
    this._publish(
      `homecore/plugins/${this.pluginId}/capabilities`,
      JSON.stringify(this._capabilities.toJSON()),
      { qos: 1, retain: true },
    );
  }

  /**
   * Push a heartbeat as soon as the notice set changes.
   *
   * Notices ride on the heartbeat, so without this a condition raised just
   * after startup would not reach the UI until the next beat — up to
   * `intervalSecs` of the operator looking at a plugin that seems fine.
   */
  _onNoticesChanged() {
    if (this._managementEnabled && this._client) this._publishHeartbeat();
  }

  /**
   * Enable log forwarding to MQTT.
   *
   * @param {string} [minLevel='info'] - Minimum level to forward.
   */
  enableLogForwarding(minLevel = 'info') {
    this._logForwardEnabled = true;
    this._logForwardLevel = minLevel;
  }

  /**
   * Forward a log line to MQTT (QoS 0, not retained).
   *
   * @param {string} level   - Log level (error, warn, info, debug, trace).
   * @param {string} message - Log message.
   * @param {object|null} [fields=null] - Optional structured fields.
   */
  forwardLog(level, message, fields = null) {
    if (!this._logForwardEnabled) return;
    if (PluginBase._logLevelValue(level) < PluginBase._logLevelValue(this._logForwardLevel)) return;
    const payload = {
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      target: this.pluginId,
      message,
      fields: fields || null,
    };
    this._publish(
      `homecore/plugins/${this.pluginId}/logs`,
      JSON.stringify(payload),
      { qos: 0 },
    );
  }

  /** Convenience: forward an info log. */
  logInfo(msg, fields) { this.forwardLog('info', msg, fields); }
  /** Convenience: forward a warn log. */
  logWarn(msg, fields) { this.forwardLog('warn', msg, fields); }
  /** Convenience: forward an error log. */
  logError(msg, fields) { this.forwardLog('error', msg, fields); }
  /** Convenience: forward a debug log. */
  logDebug(msg, fields) { this.forwardLog('debug', msg, fields); }

  // ---------------------------------------------------------------------------
  // Subclass hooks
  // ---------------------------------------------------------------------------

  /**
   * Called when a command message arrives for one of this plugin's devices.
   * Subclasses must implement this method.
   *
   * @param {string} deviceId - The target device.
   * @param {object} payload  - Decoded JSON command payload.
   */
  // eslint-disable-next-line no-unused-vars
  onCommand(deviceId, payload) {
    throw new Error(`${this.constructor.name} must implement onCommand(deviceId, payload)`);
  }

  /**
   * Called once the broker connection is up.
   *
   * Register your devices here rather than in the constructor, so a reconnect
   * re-registers them. Call {@link PluginBase#enableManagement} here too.
   */
  onConnect() {}

  /**
   * Handle a capability action you declared in the manifest.
   *
   * Return an object for an immediate action — or a promise of one. For a
   * streaming action, `ctx` is a {@link StreamContext}: report through it and
   * return nothing.
   *
   * Returning `null`/`undefined` from an *immediate* action tells the SDK you
   * do not recognise the id, and it answers with `unknown action`.
   *
   * @param {string} action - The action id.
   * @param {object} params - Everything the command carried but the envelope.
   * @param {StreamContext|null} ctx - Present only for streaming actions.
   * @returns {object|Promise<object>|null}
   */
  // eslint-disable-next-line no-unused-vars
  onAction(action, params, ctx) { return null; }

  /**
   * A device you subscribed to with {@link PluginBase#subscribeState} changed.
   *
   * Only for cross-device consumers. Devices this plugin owns arrive through
   * {@link PluginBase#onCommand} instead.
   */
  // eslint-disable-next-line no-unused-vars
  onState(deviceId, state) {}

  /**
   * Accept a structured `set_config` payload.
   *
   * homeCore sends config as raw text when the operator edits TOML directly,
   * and as an object when your plugin declared a `configSchema` and the UI
   * rendered a form. The SDK writes the text form verbatim; it cannot turn an
   * object into TOML for you, so override this if you declare a schema.
   *
   * @param {object} config - The structured config.
   * @returns {boolean} true if you handled and persisted it.
   */
  // eslint-disable-next-line no-unused-vars
  onSetConfig(config) { return false; }

  /**
   * Extract a HomeCore change record from an inbound command payload.
   *
   * @param {object} commandPayload - Decoded JSON command payload.
   * @returns {object|null}
   */
  extractCommandChange(commandPayload) {
    if (!commandPayload || typeof commandPayload !== 'object' || Array.isArray(commandPayload)) {
      return null;
    }
    const hc = commandPayload._hc;
    if (!hc || typeof hc !== 'object' || Array.isArray(hc)) {
      return null;
    }
    const change = hc.command;
    if (!change || typeof change !== 'object' || Array.isArray(change)) {
      return null;
    }
    return { ...change };
  }

  /**
   * Resolve a command payload into a concrete HomeCore-originated change record.
   *
   * @param {object} commandPayload - Decoded JSON command payload.
   * @param {string} [fallbackSource] - Source label if the command had no metadata.
   * @returns {object}
   */
  changeFromCommand(commandPayload, fallbackSource = this.pluginId) {
    return this.extractCommandChange(commandPayload) || {
      changed_at: new Date().toISOString(),
      kind: 'homecore',
      source: fallbackSource,
    };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Connect to the broker and start the event loop.
   * Returns the underlying mqtt.js client for advanced use.
   *
   * @returns {import('mqtt').MqttClient}
   */
  run() {
    const url = `mqtt://${this.brokerHost}:${this.brokerPort}`;
    const opts = {
      clientId: this.pluginId,
      clean: true,
      ...(this.password ? { username: this.pluginId, password: this.password } : {}),
    };

    this._client = mqtt.connect(url, opts);

    this._client.on('connect', () => {
      console.log(`[${this.pluginId}] Connected to ${url}`);
      // Re-subscribe to the devices we already knew about. On a reconnect the
      // broker has forgotten our subscriptions, and onConnect may register the
      // same devices again — idempotent, but this covers lazy registration.
      for (const deviceId of this._devices) {
        this._client.subscribe(`homecore/devices/${deviceId}/cmd`, { qos: 1 });
      }
      if (this._managementEnabled) {
        this._client.subscribe(`homecore/plugins/${this.pluginId}/manage/cmd`, { qos: 1 });
        this._publishCapabilities();
      }
      this.onConnect();
    });

    this._client.on('message', (topic, message) => {
      const parts = topic.split('/');
      // Route homecore/devices/{deviceId}/cmd → onCommand
      if (parts.length === 4 && parts[0] === 'homecore' && parts[1] === 'devices' && parts[3] === 'cmd') {
        const deviceId = parts[2];
        // Belt and braces alongside the per-device subscription: a broker that
        // hands us a topic we did not ask for must not turn into this plugin
        // acting on another plugin's device.
        if (!this._devices.has(deviceId)) return;
        let payload;
        try {
          payload = JSON.parse(message.toString());
        } catch {
          payload = { raw: message.toString() };
        }
        this.onCommand(deviceId, payload);
        return;
      }

      // State of a device owned by someone else, for cross-device consumers.
      if (parts.length === 4 && parts[0] === 'homecore' && parts[1] === 'devices' && parts[3] === 'state') {
        let state;
        try {
          state = JSON.parse(message.toString());
        } catch {
          return;
        }
        if (state && typeof state === 'object') this.onState(parts[2], state);
        return;
      }

      // Route management commands
      if (this._managementEnabled && topic === `homecore/plugins/${this.pluginId}/manage/cmd`) {
        this._handleManagementCmd(message);
      }
    });

    this._client.on('error', (err) => {
      console.error(`[${this.pluginId}] MQTT error:`, err.message);
    });

    this._client.on('reconnect', () => {
      console.log(`[${this.pluginId}] Reconnecting…`);
    });

    return this._client;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  _publish(topic, payload, opts = {}) {
    if (!this._client) {
      console.warn(`[${this.pluginId}] publish called before run(): topic=${topic}`);
      return;
    }
    this._client.publish(topic, payload, opts, (err) => {
      if (err) console.error(`[${this.pluginId}] publish error on ${topic}:`, err.message);
    });
  }

  _handleManagementCmd(message) {
    let cmd;
    try {
      cmd = JSON.parse(message.toString());
    } catch {
      return;
    }
    const requestId = cmd.request_id;

    switch (cmd.action) {
      case 'ping':
        this._respond(requestId);
        break;

      case 'get_config':
        if (this._configPath) {
          try {
            // The key is `data`. Core reads resp["data"] and falls back to the
            // whole envelope when it is absent, so getting this wrong shows the
            // operator {request_id, status, ...} where the config should be.
            const data = fs.readFileSync(this._configPath, 'utf8');
            this._respond(requestId, { extra: { data } });
          } catch (err) {
            this._respond(requestId, { error: err.message });
          }
        } else {
          this._respond(requestId, { error: 'no config path configured' });
        }
        break;

      case 'set_config':
        this._handleSetConfig(cmd, requestId);
        break;

      case 'cancel': {
        const ctx = this._activeStreams.get(cmd.target_request_id);
        if (!ctx) {
          this._respond(requestId, { error: 'no active stream for target_request_id' });
        } else {
          ctx._cancel();
          this._respond(requestId);
        }
        break;
      }

      case 'respond': {
        const ctx = this._activeStreams.get(cmd.target_request_id);
        if (!ctx) {
          this._respond(requestId, { error: 'no active awaiting_user stream for target_request_id' });
        } else {
          ctx._deliverResponse(cmd.response || {});
          this._respond(requestId);
        }
        break;
      }

      case 'set_log_level':
        this._logLevel = cmd.level;
        this._respond(requestId);
        break;

      default:
        this._dispatchAction(cmd, requestId);
        break;
    }
  }

  /**
   * Write a `set_config` payload.
   *
   * Core sends a string when the operator edited raw TOML, and an object when
   * the plugin declared a configSchema and the UI rendered a form. The string
   * is written verbatim. An object needs TOML serialisation, which this SDK
   * does not do — {@link PluginBase#onSetConfig} is where a plugin that
   * declares a schema takes over.
   */
  _handleSetConfig(cmd, requestId) {
    if (!this._configPath) {
      this._respond(requestId, { error: 'no config path configured' });
      return;
    }
    let config = cmd.config;
    // Core forwards the request body when it has no top-level `config` key, so
    // the raw-TOML editor arrives as { raw: "<text>" } rather than a bare
    // string. Unwrap it — otherwise the verbatim path is unreachable for a
    // remote plugin and the operator's TOML is refused.
    if (config && typeof config === 'object' && typeof config.raw === 'string') {
      config = config.raw;
    }
    if (typeof config !== 'string') {
      if (this.onSetConfig(config)) {
        this._respond(requestId);
      } else {
        this._respond(requestId, {
          error: 'structured config received; override onSetConfig(config) to '
               + 'accept it, or edit the raw form instead',
        });
      }
      return;
    }
    try {
      fs.writeFileSync(this._configPath, config, 'utf8');
      this._respond(requestId);
    } catch (err) {
      this._respond(requestId, { error: err.message });
    }
  }

  /** Route a management command that is not a built-in to {@link PluginBase#onAction}. */
  _dispatchAction(cmd, requestId) {
    const declared = this._capabilities
      ? this._capabilities.actions.find((a) => a.id === cmd.action)
      : undefined;

    // Params are everything that is not protocol envelope.
    const params = { ...cmd };
    delete params.action;
    delete params.request_id;
    delete params.target_request_id;

    if (declared && declared.stream) {
      this._startStream(declared, requestId, params);
      return;
    }

    let result;
    try {
      result = this.onAction(cmd.action, params, null);
    } catch (err) {
      this._respond(requestId, { error: `action failed: ${err.message || err}` });
      return;
    }

    Promise.resolve(result).then(
      (value) => {
        if (value == null) {
          this._respond(requestId, { error: `unknown action: ${cmd.action}` });
        } else {
          this._respond(requestId, { extra: value });
        }
      },
      (err) => this._respond(requestId, { error: `action failed: ${err.message || err}` }),
    );
  }

  /** Run a streaming action and answer `accepted` straight away. */
  _startStream(declared, requestId, params) {
    if (!requestId) {
      this._respond('', { error: 'streaming action requires request_id' });
      return;
    }

    if (declared.concurrency === Concurrency.SINGLE) {
      for (const [rid, ctx] of this._activeStreams) {
        if (ctx.actionId === declared.id) {
          this._respond(requestId, { status: 'busy', extra: { active_request_id: rid } });
          return;
        }
      }
    }

    const ctx = new StreamContext(this, requestId, declared.id);
    this._activeStreams.set(requestId, ctx);

    // The handler may be async. Whatever happens, exactly one terminal stage
    // must land and the retained topic must be cleared.
    Promise.resolve()
      .then(() => this.onAction(declared.id, params, ctx))
      .then(
        () => ctx._finalize(null),
        (err) => ctx._finalize(err),
      )
      .then(() => this._activeStreams.delete(requestId));

    this._respond(requestId, { status: 'accepted', extra: { stream_topic: ctx.topic } });
  }

  _respond(requestId, { status = 'ok', error = null, extra = null } = {}) {
    const body = { request_id: requestId };
    if (error != null) {
      body.status = 'error';
      body.error = error;
    } else {
      body.status = status;
      if (extra) Object.assign(body, extra);
    }
    this._publish(
      `homecore/plugins/${this.pluginId}/manage/response`,
      JSON.stringify(body),
      { qos: 1 },
    );
  }

  /**
   * Record a device as ours and subscribe to its command topic.
   *
   * Registration and subscription are one step here on purpose. In the Rust SDK
   * they are separate calls, and forgetting the second is the classic
   * first-plugin bug: the device appears in homeCore, its state updates, and
   * every command silently goes nowhere.
   */
  _trackDevice(deviceId) {
    const isNew = !this._devices.has(deviceId);
    this._devices.add(deviceId);
    if (isNew && this._client) {
      this._client.subscribe(`homecore/devices/${deviceId}/cmd`, { qos: 1 });
    }
  }

  static _logLevelValue(level) {
    const map = { trace: 1, debug: 2, info: 3, warn: 4, error: 5 };
    return map[(level || '').toLowerCase()] || 0;
  }

  _withStateChangeMetadata(payload, change) {
    if (!change || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return payload;
    }
    const nextPayload = { ...payload };
    const nextHc = nextPayload._hc && typeof nextPayload._hc === 'object' && !Array.isArray(nextPayload._hc)
      ? { ...nextPayload._hc }
      : {};
    nextHc.change = { ...change };
    nextPayload._hc = nextHc;
    return nextPayload;
  }
}

module.exports = {
  PluginBase,
  // Notices
  PluginNotice,
  PluginNotices,
  NoticeLevel,
  // Capability actions
  Capabilities,
  Action,
  Concurrency,
  ItemOp,
  RequiresRole,
  // Streaming actions
  StreamContext,
  StreamTerminated,
  // Device persistence
  scopedSnapshotPath,
  // Versions reported in the heartbeat
  SDK_VERSION,
  PROTOCOL_VERSION,
};
