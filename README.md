# hc-plugin-sdk-js

Node.js plugin SDK for HomeCore. Extend `PluginBase`, implement `onCommand`, call `run()`.

## Quick start

```bash
npm install path/to/hc-plugin-sdk-js
```

```javascript
const { PluginBase } = require('homecore-plugin-sdk');

class MyPlugin extends PluginBase {
    async onCommand(deviceId, payload) {
        console.log(`Command for ${deviceId}:`, payload);
    }
}

const plugin = new MyPlugin({ pluginId: 'plugin.example' });
await plugin.registerDeviceFull('example_sensor', 'Example Sensor', { deviceType: 'sensor' });
await plugin.publishState('example_sensor', { temperature: 21.5 });
await plugin.run();
```

## Features

- **PluginBase** — base class handling MQTT connection and command dispatch
- **Device registration** — full schema or by type name
- **State publishing** — full (retained) and partial (merge-patch)
- **Management protocol** — heartbeat, remote config, dynamic log level
- **Log forwarding** — configurable min level forwarded to core via MQTT
- **Configuration** — constructor options, env vars (`HC_BROKER_HOST`, `HC_BROKER_PORT`, `HC_PLUGIN_PASSWORD`), or defaults

## What this SDK does not have

The Rust and Python SDKs are ahead of this one in two places worth knowing
about before you choose a language:

- **Notices** — the structured, self-clearing problem reports the web UI shows
  on a plugin's card ("bridge unreachable", "no devices found yet"). A plugin
  written with this SDK can log a problem, but cannot surface it there.
- **Capability actions** — the plugin-level command manifest that makes the UI
  render buttons ("Pair bridge", "Rescan") and lets MCP call them, with no UI
  code. Device *capability schemas* work fine here; it is the plugin's own
  action manifest that is missing.

It also subscribes to `homecore/devices/+/cmd`, so it receives commands for
devices belonging to other plugins and your handler has to ignore them. The
Rust and Python SDKs subscribe per device.

Everything else — registration, state publishing, availability, the
management protocol, log forwarding — is the same across all four SDKs.

Requires Node.js 18+.
