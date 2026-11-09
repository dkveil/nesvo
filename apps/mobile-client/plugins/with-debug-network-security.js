const { mkdir, readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { withDangerousMod } = require('expo/config-plugins');

const resourceName = 'nesvo_debug_network_security';
const attribute = `android:networkSecurityConfig="@xml/${resourceName}"`;
const securityConfig = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="true">
    <trust-anchors>
      <certificates src="system" />
      <certificates src="user" />
    </trust-anchors>
  </base-config>
</network-security-config>
`;

const withDebugNetworkSecurity = config =>
  withDangerousMod(config, [
    'android',
    async value => {
      const debug = join(
        value.modRequest.platformProjectRoot,
        'app',
        'src',
        'debug',
      );
      await mkdir(join(debug, 'res', 'xml'), { recursive: true });
      await writeFile(
        join(debug, 'res', 'xml', `${resourceName}.xml`),
        securityConfig,
      );
      const manifestPath = join(debug, 'AndroidManifest.xml');
      const manifest = await readFile(manifestPath, 'utf8');
      if (manifest.includes(attribute)) return value;
      const applications = manifest.match(/<application\b/g) ?? [];
      if (applications.length !== 1)
        throw new Error(
          'withDebugNetworkSecurity: expected one application element in the debug manifest',
        );
      await writeFile(
        manifestPath,
        manifest.replace('<application', `<application ${attribute}`),
      );
      return value;
    },
  ]);

module.exports = withDebugNetworkSecurity;
