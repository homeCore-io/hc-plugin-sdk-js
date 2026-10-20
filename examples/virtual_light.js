#!/usr/bin/env node
'use strict';

/**
 * virtual_light.js — A software-only dimmable light plugin for HomeCore.
 *
 * Simulates a dimmable light bulb.  On startup it registers with the broker,
 * publishes its initial state, then toggles on/off and steps brightness every
 * 5 seconds.  It also responds to commands received via MQTT.
 *
 * It speaks homeCore's device vocabulary: `on` and `brightness_pct` (0–100,
 * 0 meaning off), and the one declared action `{"action": "toggle"}`.
 * `{"on": true}` restores the last level. A real light converts its own scale
 * (0–255, 0–254, 0–99, …) to `brightness_pct` inside the plugin.
 *
 * Usage:
 *   npm install
 *   node examples/virtual_light.js
 *   node examples/virtual_light.js --broker 192.168.1.10 --port 1883
 *   HC_BROKER_HOST=192.168.1.10 node examples/virtual_light.js
 */

const { PluginBase } = require('../index');

const DEVICE_ID = 'light.virtual_js_01';
const CAPABILITIES = {
  on:             { type: 'boolean' },
  brightness_pct: { type: 'number', minimum: 0, maximum: 100 },
};

class VirtualLightPlugin extends PluginBase {
  constructor(options = {}) {
    super({ pluginId: options.id || 'plugin.virtual_js', ...options });
    this._on = false;
    // The last level, kept while off so {"on": true} restores it.
    this._levelPct = 50;
  }

  /** What homeCore sees. On never reports 0 %; off reports 0 %. */
  _state() {
    return { on: this._on, brightness_pct: this._on ? this._levelPct : 0 };
  }

  /**
   * Apply one of the two command shapes homeCore sends: an attribute write
   * (`{"on": true}`, `{"brightness_pct": 40}`) or a declared action
   * (`{"action": "toggle"}`).
   */
  _apply(payload) {
    if (payload.action !== undefined) {
      if (payload.action === 'toggle') this._on = !this._on;
      else throw new Error(`unknown action: ${payload.action}`);
      return;
    }
    if ('on' in payload) this._on = !!payload.on;
    if ('brightness_pct' in payload) {
      const pct = Math.max(0, Math.min(100, Number(payload.brightness_pct)));
      if (pct === 0) {
        this._on = false; // 0 % is off; the level is kept for the next on
      } else {
        this._levelPct = pct;
        this._on = true;
      }
    }
  }

  onConnect() {
    this.registerDevice(DEVICE_ID, 'Virtual Light (Node.js)', CAPABILITIES, 'living_room');
    this.publishAvailability(DEVICE_ID, true);
    this.publishState(DEVICE_ID, this._state());
    this.publishPluginStatus('active');

    console.log(`[${this.pluginId}] Device registered — initial state:`, this._state());

    // Periodic toggle every 5 seconds.
    setInterval(() => {
      this._on       = !this._on;
      this._levelPct = (this._levelPct % 100) + 10;
      console.log(`[${this.pluginId}] Periodic tick — state:`, this._state());
      this.publishState(DEVICE_ID, this._state());
    }, 5000);
  }

  onCommand(deviceId, payload) {
    console.log(`[${this.pluginId}] Command for ${deviceId}:`, payload);
    try {
      this._apply(payload);
    } catch (e) {
      console.warn(`[${this.pluginId}] ${e.message}`);
    }
    this.publishStateForCommand(deviceId, this._state(), payload, 'virtual_light');
    console.log(`[${this.pluginId}] State after command:`, this._state());
  }
}

// ---------------------------------------------------------------------------
// CLI arg parsing (--key value)
// ---------------------------------------------------------------------------
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const plugin = new VirtualLightPlugin({
  id:         arg('id'),
  brokerHost: arg('broker'),
  brokerPort: arg('port') ? parseInt(arg('port'), 10) : undefined,
  password:   arg('password'),
});

console.log('Virtual light plugin starting');
console.log(`  Device ID : ${DEVICE_ID}`);
console.log(`  Broker    : ${plugin.brokerHost}:${plugin.brokerPort}`);
console.log('Press Ctrl-C to stop');

const client = plugin.run();

// Publish offline on graceful shutdown.
process.on('SIGINT', () => {
  console.log('\nShutting down…');
  plugin.publishAvailability(DEVICE_ID, false);
  plugin.publishPluginStatus('offline');
  setTimeout(() => { client.end(true); process.exit(0); }, 300);
});
