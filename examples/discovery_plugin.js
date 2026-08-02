#!/usr/bin/env node
'use strict';

/**
 * discovery_plugin.js — notices and capability actions, end to end.
 *
 * A plugin for an imaginary hub. It has nothing to control until the hub is
 * discovered, which is the situation notices exist for: without one it would
 * sit there looking healthy and doing nothing.
 *
 * Run it against a homeCore:
 *
 *   npm install homecore-plugin-sdk
 *   node discovery_plugin.js
 *   HC_BROKER_HOST=10.0.0.5 node discovery_plugin.js
 *
 * Then, in the web UI, open Plugins → Discovery Demo and you will see:
 *
 *   - a warning notice saying no hub is configured, with a remedy,
 *   - a "Discover hubs" button that streams progress and results,
 *   - a "Ping hub" button that answers immediately.
 *
 * Press Discover and the notice clears itself, because the condition it
 * reports stopped being true — that is the whole model.
 */

const {
  PluginBase, PluginNotice, Capabilities, Action, RequiresRole,
} = require('../index');

// Stand-ins for a real network sweep.
const CANDIDATE_HOSTS = Array.from({ length: 6 }, (_, i) => `10.0.0.${10 + i}`);
const HUBS_THAT_ANSWER = { '10.0.0.12': 'HUB-A1B2' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class DiscoveryPlugin extends PluginBase {
  constructor(options) {
    super({ pluginId: 'plugin.discovery_demo_js', ...options });
    this.hubHost = null;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  onConnect() {
    this.enableManagement({
      intervalSecs: 30,
      version: '1.0.0',
      capabilities: new Capabilities([
        new Action({
          id: 'discover_hubs',
          label: 'Discover hubs',
          description: 'Probe the local subnet for hubs and register what answers.',
          stream: true,
          cancelable: true,
          itemKey: 'serial',
          // Above the realistic worst case: core's default window is short, and
          // a sweep that gets cut off looks like a broken plugin rather than a
          // slow network.
          timeoutMs: 30000,
        }),
        new Action({
          id: 'ping_hub',
          label: 'Ping hub',
          description: 'Check the configured hub is still answering.',
          result: { reachable: { type: 'boolean' } },
        }),
        new Action({
          id: 'forget_hub',
          label: 'Forget hub',
          description: 'Unregister the hub and its devices.',
          // Destructive, so an operator account should not press it by accident.
          requiresRole: RequiresRole.ADMIN,
        }),
      ]),
    });
    this._refreshNotices();
  }

  onCommand(deviceId, payload) {
    const state = {};
    for (const [k, v] of Object.entries(payload)) {
      if (!k.startsWith('_')) state[k] = v;
    }
    this.publishStateForCommand(deviceId, state, payload, 'discovery_demo');
  }

  // ── actions ──────────────────────────────────────────────────────────────

  async onAction(action, params, ctx) {
    if (action === 'discover_hubs') return this._discover(ctx);
    if (action === 'ping_hub') return { reachable: this.hubHost in HUBS_THAT_ANSWER };
    if (action === 'forget_hub') {
      if (!this.hubHost) return { status: 'nothing to forget' };
      this.unregisterDevice(`hub_${HUBS_THAT_ANSWER[this.hubHost]}`);
      this.hubHost = null;
      this._refreshNotices();
      return { status: 'forgotten' };
    }
    return null; // not ours — the SDK answers "unknown action"
  }

  /** A streaming action: report as it goes, and stay cancelable. */
  async _discover(ctx) {
    let found = 0;
    for (const [i, host] of CANDIDATE_HOSTS.entries()) {
      // Cancellation is cooperative — nothing interrupts this loop, so it has
      // to be checked. Emitting `canceled` is also ours to do, because only we
      // know when any rollback is finished.
      if (ctx.isCanceled()) {
        ctx.canceled();
        return null;
      }

      ctx.progress({
        percent: Math.floor((100 * i) / CANDIDATE_HOSTS.length),
        message: `Probing ${host}`,
      });
      await sleep(300); // a real probe would be a socket timeout

      const serial = HUBS_THAT_ANSWER[host];
      if (!serial) continue;

      found += 1;
      this.hubHost = host;
      const deviceId = `hub_${serial}`;
      this.registerDeviceFull(deviceId, `Hub ${serial}`, { deviceType: 'switch' });
      this.publishAvailability(deviceId, true);
      this.publishState(deviceId, { on: false });
      // `serial` is the manifest's itemKey, so the UI keys the row on it and an
      // update lands on the same row rather than appending another.
      ctx.itemAdd({ serial, host, name: `Hub ${serial}` });
    }

    if (found === 0) {
      // Non-terminal: the sweep finished, it just found nothing. An error would
      // be wrong — nothing failed.
      ctx.warning('No hubs answered on this subnet.');
    }

    this._refreshNotices();
    ctx.complete({ found });
    return null;
  }

  // ── notices ──────────────────────────────────────────────────────────────

  /**
   * Re-derive every condition from current state.
   *
   * Called after connect and after each sweep. Deriving the whole set and
   * calling `set` cannot leave a stale notice behind, which is the failure mode
   * of scattered raise/clear pairs.
   */
  _refreshNotices() {
    const notices = [];
    if (!this.hubHost) {
      notices.push(PluginNotice.warning(
        'no_hub_configured',
        'No hub has been found, so this plugin publishes nothing.',
        { remedy: 'Run the Discover hubs action.' },
      ));
    } else if (!(this.hubHost in HUBS_THAT_ANSWER)) {
      notices.push(PluginNotice.error(
        'hub_unreachable',
        `The hub at ${this.hubHost} stopped answering.`,
        { remedy: 'Check that it is powered on and on this network.' },
      ));
    }
    this.notices.set(notices);
  }
}

if (require.main === module) {
  new DiscoveryPlugin().run();
}

module.exports = { DiscoveryPlugin };
