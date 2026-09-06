const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');
const config = getDefaultConfig(__dirname);
// Share the credential-free file-link parser, not the entire desktop workspace.
config.watchFolders = [...(config.watchFolders || []), path.resolve(__dirname, '../../packages/shared')];
module.exports = config;
