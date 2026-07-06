const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Bundle the prebuilt SQLite food database as an asset
config.resolver.assetExts.push('db');

// @anthropic-ai/sdk lazily imports node:fs/node:path for CLI credential
// profiles — a code path never reached in the app (the API key is passed
// explicitly). Metro resolves imports statically, so stub node builtins.
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith('node:')) {
    return { type: 'empty' };
  }
  return (defaultResolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
