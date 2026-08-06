'use strict';
// Terminal rendering for `cheaper peek`. Self-contained (no imports outside this
// folder) so the whole peek/ directory can be vendored into the desktop app.

const c = {
  amber: (s) => `\x1b[38;5;208m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

function money(n) {
  const v = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: Math.abs(n) >= 100 ? 0 : 2,
                                           maximumFractionDigits: 2 });
}
function tokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function statusTag(st) {
  if (st === 'supported') return c.green('●');
  if (st === 'experimental') return c.amber('◐');
  return c.dim('○');
}

function render(report) {
  const L = [];
  const T = report.totals;
  L.push('');
  L.push('  ' + c.amber('cheaper peek') + c.dim('  — what adaptive routing would have saved'));
  const since = report.opts.sinceDays ? `last ${report.opts.sinceDays}d` : 'all history';
  L.push('  ' + c.dim(`scanned ${since} across your harness chat logs`));
  L.push('');

  // Per-harness table
  L.push('  ' + c.dim(pad('harness', 16) + pad('calls', 8) + pad('downgradable', 14) + pad('tokens', 9) + 'you’d save'));
  for (const h of report.harnesses) {
    if (h.error) {
      L.push('  ' + statusTag(h.status) + ' ' + pad(h.label, 14) + c.red('error: ' + h.error));
      continue;
    }
    if (!h.calls) {
      const why = h.note || (h.status === 'sqlite' ? 'DB-backed (not yet readable)' : 'no history found');
      L.push('  ' + statusTag(h.status) + ' ' + pad(h.label, 14) + c.dim(why));
      continue;
    }
    const dg = `${h.downgradable} (${Math.round(h.downgradable / h.calls * 100)}%)`;
    const spent = Math.max(0, h.dollarsActual - h.dollarsSaved);
    L.push('  ' + statusTag(h.status) + ' ' + pad(h.label, 14) +
      pad(h.calls, 8) + pad(dg, 14) + pad(tokens(h.tokens), 9) +
      c.green(money(h.dollarsSaved)) + c.dim(' / ') + c.red(money(spent)));
  }
  L.push('');

  // Headline
  const pct = Math.round(T.savedPct);
  L.push('  ' + c.bold('Total') + '   ' +
    `${T.calls} calls · ${c.amber(T.downgradable + ' downgradable')} · ` +
    `${c.dim('from you ' + T.bySource.user + ' / sub-agents ' + T.bySource.subagent)}`);
  const totalSpent = Math.max(0, T.dollarsActual - T.dollarsSaved);
  L.push('  ' + c.dim('Spent on record   ') + money(T.dollarsActual));
  L.push('  ' + c.bold('Could have saved  ') + c.green(money(T.dollarsSaved)) +
    c.green(`  (${pct}% off)`) + c.dim(`  · ${tokens(T.tokensOnDowngradable)} tokens re-routable`));
  L.push('  ' + c.dim('Saved / spent     ') + c.green(money(T.dollarsSaved)) +
    c.dim(' / ') + c.red(money(totalSpent)));
  if (T.annualizedSaved != null) {
    L.push('  ' + c.dim('Annualized        ') + c.green(money(T.annualizedSaved) + '/yr') +
      c.dim(`  (extrapolated from ${report.opts.sinceDays}d)`));
  }
  L.push('');

  // Examples
  const ex = [];
  for (const h of report.harnesses) for (const e of h.examples || []) ex.push({ ...e, harness: h.label });
  ex.sort((a, b) => b.saved - a.saved);
  if (ex.length) {
    L.push('  ' + c.dim('Biggest opportunities (top-tier calls that didn’t need it):'));
    for (const e of ex.slice(0, 6)) {
      const tag = e.source === 'subagent' ? c.cyan('sub-agent') : c.dim('you');
      L.push('   ' + c.green(money(e.saved).padStart(7)) + '  ' +
        c.dim(pad(`${e.from}→${e.to}`, 13)) + tag + '  ' + c.dim(e.text));
    }
    L.push('');
  }

  if (T.estimatedCalls) {
    L.push('  ' + c.dim(`${T.estimatedCalls} call(s) had no logged token counts — estimated from prompt length.`));
  }
  L.push('  ' + c.dim('Assumes the model each call used was the intended ceiling; harness-auto-selected'));
  L.push('  ' + c.dim('models (titles, summaries) can nudge this. Install to measure the real thing:'));
  L.push('  ' + '  npx cheaper install --all  ' + c.dim('&&') + '  cheaper gateway start');
  L.push('');
  return L.join('\n');
}

module.exports = { render, money, tokens };
