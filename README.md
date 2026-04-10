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

Requires Node.js 18+.
