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
    dashboard | reports | logs | monitor
                        Open the live localhost dashboard at that tab in your
                        browser (starts the gateway if needed). launch = Dashboard.
                        Every one also PRINTS, so nothing is browser-only:
                        --terminal          render the same view in the terminal
                        --json              the same data, for scripts
                        monitor --json [--watch]  raw /metrics, single-shot or streamed
    savings             Realized savings by period, bucketed on WHEN THE CALLS
                        HAPPENED. Disjoint windows that add up to lifetime.
                        --json for machines.
    export [options]    Stream the full audit register to a file.
                        --format csv|tsv|json|ndjson   --out FILE
                        --from/--to YYYY-MM-DD  --tz IANA  --basis measured|estimated
                        --guard safe|raw   (safe blocks spreadsheet formula execution
                                            and is therefore not byte-reversible)
    import --since D    Backfill per-call events from your existing transcripts.
                        Walks every file with no cap, timestamps each call at its OWN
                        event time, and marks backfilled rows permanently ESTIMATED.
                        --dry-run first.  --harness <key>  --json
    forget --session I  Exclude one chat from every total, leaving a tombstone so the
                        drop is stated rather than silent.
    compact             Seal finished months: merge, dedupe, verify, gzip. Explicit
                        only — never runs from a hook. --dry-run  --json
    peek [options]      Scan your existing harness chat logs (.claude, .codex,
                        …) and estimate the tokens + real $ adaptive routing
                        would have saved — 100% local, nothing is sent anywhere.
                        Options: --days N  --harness <key>  --limit N  --json
                        --tagline           Print the one-line, Cheaper.app-branded
                                            savings summary for a single chat (what
                                            each harness appends at end of chat).
                        --transcript <file> | --session <id> | --current
                                            Scope --tagline to one conversation.
    taglines [options]  Wire the Cheaper.app end-of-chat savings line into every
                        supported harness (Codex, Cursor, Copilot, Grok, Gemini,
                        OpenCode, PI.dev). Claude Code is handled by the plugin.
                        Options: --all  --harness <key>  --remove  --dry-run
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
    // Every localhost view has a print equivalent. The NO-FLAG default is unchanged in
    // all four cases — it opens the browser, which is muscle memory — and `--terminal`
    // / `--json` are strictly additive.
    case 'monitor':
      if (rest.includes('--terminal') || rest.includes('--tty') || rest.includes('--json'))
        return require('../src/monitor').run(rest);
      return require('../src/launch').run(rest, { tab: 'monitor' });
    case 'reports':
      return require('../src/reports').run(rest);
    case 'logs':
      return require('../src/logs').run(rest);
    case 'dashboard':
      if (rest.includes('--json')) return require('../src/dashboard').run(rest);
      return require('../src/launch').run(rest, { tab: 'dashboard' });
    case 'launch':
    case 'init':
      return require('../src/launch').run(rest, { tab: 'dashboard' });
    case 'peek':
      return require('../src/peek').run(rest);
    case 'savings':
      return require('../src/savings').run(rest);
    case 'export':
      return require('../src/export').run(rest);
    case 'import':
      return require('../src/import').run(rest);
    case 'forget':
      return require('../src/forget').forget(rest);
    case 'compact':
      return require('../src/forget').compact(rest);
    case 'taglines':
      return require('../src/tagline_install').run(rest);
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
      // Existence is not freshness. Installed-but-stale and running-but-stale both
      // look identical to the checks above, and both silently produce wrong numbers.
      await require('../src/freshness_report').print({ verbose: rest.includes('--verbose') });
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
