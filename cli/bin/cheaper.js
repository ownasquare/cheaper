#!/usr/bin/env node
'use strict';
const { c } = require('../src/util');

const VERSION = require('../package.json').version;

const HELP = `
  ${c.amber('Cheaper')} ${c.dim('v' + VERSION)} — adaptive Claude model routing

  ${c.bold('Usage')}
    cheaper <command> [options]

  ${c.bold('Commands')}
    install [skill agents hook gateway plugin] [--all]
                        Install components into your Claude environment.
                        --all / no args = skill+agents+hook+gateway (the
                        reliable set). "plugin" is a managed bundle of
                        skill+agents+hook — install it instead of those three.
    uninstall [components] [--purge]
                        Remove installed components (default: all). --purge
                        also deletes ~/.cheaper (including gateway metrics).
    gateway start       Start the routing gateway (proxy + monitor).
    gateway stop        Stop the gateway.
    gateway status      Is the gateway running?
    monitor             Live routing/savings monitor in the terminal.
    status              Show what's installed and running.
    help, --help        This help.
    version, --version  Print version.

  ${c.bold('Quickstart')}
    npx cheaperapp install --all
    cheaper gateway start
    export ANTHROPIC_BASE_URL=http://localhost:8787
    cheaper monitor
`;

async function main() {
  const [, , cmd, ...rest] = process.argv;

  switch (cmd) {
    case 'install':
      return require('../src/install').run(rest);
    case 'uninstall':
      return require('../src/uninstall').run(rest);
    case 'gateway':
      return require('../src/gateway').run(rest);
    case 'monitor':
      return require('../src/monitor').run();
    case 'status': {
      const P = require('../src/paths');
      const fs = require('fs');
      const path = require('path');
      const { pluginRegistered } = require('../src/install');
      const { readJSON } = require('../src/util');
      const has = (p) => (fs.existsSync(p) ? c.green('installed') : c.dim('not installed'));
      const agentsInstalled = ['router-triage.md', 'router-solver-sonnet.md', 'router-solver-opus.md']
        .every((f) => fs.existsSync(path.join(P.AGENTS_DIR, f)));
      // The hook is "installed" only when it's actually wired into settings.json.
      const hookWired = JSON.stringify(readJSON(P.SETTINGS, {}).hooks || {}).includes('router-policy');
      console.log('');
      console.log('  skill    ' + has(path.join(P.SKILLS_DIR, 'adaptive-model-router')));
      console.log('  agents   ' + (agentsInstalled ? c.green('installed') : c.dim('not installed')));
      console.log('  hook     ' + (hookWired ? c.green('installed') : c.dim('not installed')));
      console.log('  plugin   ' + (pluginRegistered() ? c.green('registered + enabled') : c.dim('not installed')));
      console.log('  gateway  ' + has(P.GATEWAY_DIR));
      require('../src/gateway').status();
      console.log('');
      return;
    }
    case 'version':
    case '--version':
    case '-v':
      return console.log('cheaper ' + VERSION);
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      return console.log(HELP);
    default:
      console.log(c.red(`  Unknown command: ${cmd}`));
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
