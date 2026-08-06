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
    launch, init        Open the live savings dashboard in your browser
                        (starts the gateway if needed, keeps peek data fresh).
    peek [options]      Scan your existing harness chat logs (.claude, .codex,
                        …) and estimate the tokens + real $ adaptive routing
                        would have saved — 100% local, nothing is sent anywhere.
                        Options: --days N  --harness <key>  --limit N  --json
    status              Show what's installed and running.
    help, --help        This help.
    version, --version  Print version.

  ${c.bold('Quickstart')}
    npx cheaper peek          ${c.dim('# see what you WOULD have saved, from your logs')}
    npx cheaper install --all
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
    case 'launch':
    case 'init':
      return require('../src/launch').run(rest);
    case 'peek':
      return require('../src/peek').run(rest);
    case 'status': {
      const s = require('../src/install').status();
      const yn = (b) => (b ? c.green('installed') : c.dim('not installed'));
      console.log('');
      console.log('  skill    ' + yn(s.skill));
      console.log('  agents   ' + yn(s.agents));
      console.log('  hook     ' + yn(s.hook));
      console.log('  plugin   ' + (s.plugin ? c.green('registered + enabled') : c.dim('not installed')));
      console.log('  gateway  ' + yn(s.gateway));
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
