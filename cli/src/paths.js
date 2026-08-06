'use strict';
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const CHEAPER_DIR = path.join(HOME, '.cheaper');
const PLUGINS_DIR = path.join(CLAUDE_DIR, 'plugins');

// The local marketplace this installer registers with Claude so the plugin
// bundle (skill + hook + tiered agents) loads as one managed unit.
const MARKETPLACE_NAME = 'cheaper-local';
const PLUGIN_NAME = 'adaptive-model-router';

module.exports = {
  HOME,
  CLAUDE_DIR,
  CHEAPER_DIR,
  SKILLS_DIR: path.join(CLAUDE_DIR, 'skills'),
  AGENTS_DIR: path.join(CLAUDE_DIR, 'agents'),
  PLUGINS_DIR,
  SETTINGS: path.join(CLAUDE_DIR, 'settings.json'),
  HOOK_POLICY: path.join(CHEAPER_DIR, 'router-policy.md'),
  GATEWAY_DIR: path.join(CHEAPER_DIR, 'gateway'),
  GATEWAY_PID: path.join(CHEAPER_DIR, 'gateway.pid'),
  GATEWAY_LOG: path.join(CHEAPER_DIR, 'gateway.log'),

  // Modern (registry v2) plugin wiring.
  MARKETPLACE_NAME,
  PLUGIN_NAME,
  PLUGIN_ID: `${PLUGIN_NAME}@${MARKETPLACE_NAME}`,
  // The local marketplace *source* we build and hand to Claude.
  MARKETPLACE_DIR: path.join(CHEAPER_DIR, 'marketplace'),
  // Claude's plugin registry files.
  KNOWN_MARKETPLACES: path.join(PLUGINS_DIR, 'known_marketplaces.json'),
  INSTALLED_PLUGINS: path.join(PLUGINS_DIR, 'installed_plugins.json'),
  PLUGINS_CACHE: path.join(PLUGINS_DIR, 'cache'),
  // Legacy location an older installer copied a bare plugin dir into — Claude
  // never discovered it there; we clean it up on install.
  LEGACY_PLUGIN_DIR: path.join(PLUGINS_DIR, PLUGIN_NAME),

  // Where this package's bundled assets live.
  ASSETS: path.join(__dirname, '..', 'assets'),
};
