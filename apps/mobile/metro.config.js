const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const config = getDefaultConfig(__dirname);
const root = path.resolve(__dirname, '../..');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const excluded = ['target', 'host', 'tui', 'artifacts', 'apps/host', 'apps/tui', 'crates'];
const defaults = config.resolver.blockList;
config.resolver.blockList = [
  ...(Array.isArray(defaults) ? defaults : defaults ? [defaults] : []),
  ...excluded.map(directory => new RegExp(`^${escape(path.join(root, directory))}([/\\\\].*)?$`)),
];

module.exports = config;
