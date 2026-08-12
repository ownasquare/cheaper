// chart_primitives.js — the shared chart vocabulary for dashboard.html and report.html.
//
// WHY THIS FILE EXISTS, AND WHY IT IS NOT A CHARTING LIBRARY.
//
// This product ships no charting dependency, and the reason is not bundle size. Every
// honesty invariant here is proven by string-asserting the RENDERED DOM — cli/test/html.test.js
// parses `<line class="zero">` and counts `<circle class="dot">` to prove that a bucket with
// no measurement is dropped rather than plotted at zero. Chart.js and its peers render to
// <canvas>, which makes those assertions impossible, kills the print path, and hides every
// figure from a screen reader. For a product whose entire differentiator is refusing to draw
// an unmeasured number as a measured one, giving up DOM-assertable output would be a category
// error independent of kilobytes.
//
// What this file fixes is the OTHER failure mode. Four panels had each hand-rolled their own
// geometry, and the honesty rule was a convention re-applied by hand in every one of them —
// which is exactly how renderSpark came to plot $80.52 in confident green while the banner
// directly above it explained the figure was not measured. A convention that must be
// remembered at each call site will eventually not be. So the rule lives HERE, at one
// chokepoint, and the shapes are built from primitives that cannot draw without consulting it.
//
// DELIVERY: this file is inlined into both pages by app.py at request time, through the same
// placeholder substitution the report already used for its payload. (The placeholder token is
// deliberately not written out here: this text ends up INSIDE the served page, and a file that
// names its own marker leaves that marker in the output — harmless in a comment, but it makes
// "did the substitution happen" unanswerable by grep.) No build step, no
// bundler, no CDN, no dependency, and offline operation is satisfied by construction — the
// bytes are on disk beside the page. It defines top-level functions, so it lands as globals in
// the page's own script scope and the existing IIFEs can call it without being rewritten.
//
// PACKAGING: cli/package.json's `files` list had only *.py, *.json and *.html under
// assets/gateway/app. This file is *.js, so that list is extended alongside it — otherwise
// everything here works in the repo and ships to nobody.

// ---- COLOUR -----------------------------------------------------------------------------
//
// A presentation attribute cannot carry var(), so any colour reaching an SVG stroke/fill or an
// inline style must be resolved in JS at render time — and resolved from the CASCADE, never
// from a literal, or the chart stops following the theme. Both pages define the same hex
// values under DIFFERENT token names (dashboard.html: --text/--card/--muted; report.html:
// --ink/--panel/--mut/--soft), so callers pass the token name their own page uses and the
// fallback is only reached in the node test driver, where getComputedStyle does not exist.
function chartColor(name, fallback) {
  try {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (v) return v;
  } catch (e) { /* no cascade here (test driver) — fall through */ }
  return fallback;
}

function chartEsc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function chartNum(v, d) { v = Number(v); return isFinite(v) ? v : (d === undefined ? 0 : d); }

// ---- THE CHOKEPOINT ----------------------------------------------------------------------
//
// THE one place that answers "may this be drawn as a measurement". Every shape below routes
// through it, so a new panel cannot forget the rule by omission — it has to actively pass a
// basis in, and whatever it passes is what gets rendered.
//
// The vocabulary matches metrics.py's `measurement.dollars_basis` exactly: measured /
// unmeasured / mixed / none, and `unknown` for a gateway too old to publish the block at all.
// `unknown` is NOT treated as measured: "we do not know" is not "yes", which is the same
// three-state rule measuredValue() applies to an individual figure, lifted to a whole series.
var CHART_BASES = { measured: 1, unmeasured: 1, mixed: 1, none: 1 };
function chartBasis(d) {
  var m = (d && typeof d.measurement === 'object' && d.measurement) ? d.measurement : null;
  var b = (m && typeof m.dollars_basis === 'string') ? m.dollars_basis.trim().toLowerCase() : '';
  if (!CHART_BASES[b]) b = 'unknown';
  return {
    published: !!m,
    basis: b,
    measured: b === 'measured',
    // The words a caption must carry. Taken from here rather than restated per panel, so two
    // charts on one page cannot describe the same population differently.
    label: b === 'measured' ? 'provider-measured' : 'reconstructed — not measured',
  };
}

// Counts are not dollars. A row count is the same number however the surviving rows were
// priced, so a panel over counts declares itself exempt EXPLICITLY rather than by forgetting
// to ask — the exemption is visible at the call site and in review.
function chartCountBasis() {
  return { published: true, basis: 'count', measured: true, label: 'counts' };
}

// May a series be drawn at all? Returns a reason instead of a bare false, because every
// refusal on these pages is required to say why rather than render an empty box.
function chartGuard(points, minPoints) {
  var need = minPoints === undefined ? 1 : minPoints;
  if (!Array.isArray(points)) return { ok: false, reason: 'no series was supplied' };
  if (points.length < need) {
    return { ok: false, reason: points.length + ' point' + (points.length === 1 ? '' : 's')
      + ' — fewer than the ' + need + ' this shape needs to mean anything' };
  }
  return { ok: true, reason: '' };
}

// ---- SCALES ------------------------------------------------------------------------------

// A 1/2/5x10^k ceiling, so an axis maximum is a number a reader can divide by. Never returns
// 0: a zero-height axis has no scale, and every caller would then divide by it.
function chartNiceMax(v) {
  v = Math.abs(chartNum(v, 0));
  if (!(v > 0)) return 1;
  var mag = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
  var n = v / mag;
  var step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

// Proportional widths that sum to 100, or all-zero when the total is zero. Shared because a
// stacked bar computing its own percentages per panel is how two panels end up disagreeing
// about the same split by a rounding step.
function chartSplit(values) {
  var vals = (values || []).map(function (v) { return Math.max(0, chartNum(v, 0)); });
  var tot = vals.reduce(function (a, b) { return a + b; }, 0);
  if (!(tot > 0)) return vals.map(function () { return 0; });
  return vals.map(function (v) { return (v / tot) * 100; });
}

// ---- SHAPES ------------------------------------------------------------------------------
//
// Each returns an HTML STRING and takes an explicit `basis` from chartBasis()/chartCountBasis().
// They are markup builders, not a rendering engine: the caller still owns its panel, its
// labels and its empty states. That keeps every existing panel's wording intact while making
// the geometry and the honesty rule shared.

// A signed magnitude either side of a centre line. Built for downgraded-vs-upcharged per
// model, where the SIGN is the whole point and two separate bars would bury it.
function chartDiverging(rows, opts) {
  opts = opts || {};
  var basis = opts.basis || chartBasis(null);
  var left = chartColor(opts.leftToken || '--green', '#34d399');
  var right = chartColor(opts.rightToken || '--red', '#f87171');
  var max = chartNiceMax(Math.max.apply(null, [0].concat((rows || []).map(function (r) {
    return Math.max(Math.abs(chartNum(r.left, 0)), Math.abs(chartNum(r.right, 0)));
  }))));
  var cls = 'cbar-diverging' + (basis.measured ? '' : ' unmeasured');
  var html = '<div class="' + cls + '">';
  (rows || []).forEach(function (r) {
    var l = Math.abs(chartNum(r.left, 0)), rt = Math.abs(chartNum(r.right, 0));
    html += '<div class="cbar-row">'
      + '<div class="cbar-label" title="' + chartEsc(r.label) + '">' + chartEsc(r.label) + '</div>'
      + '<div class="cbar-track">'
      + '<div class="cbar-half left"><i style="width:' + ((l / max) * 100).toFixed(1)
      + '%;background:' + left + '" title="' + chartEsc(r.leftTitle || '') + '"></i></div>'
      + '<div class="cbar-axis"></div>'
      + '<div class="cbar-half right"><i style="width:' + ((rt / max) * 100).toFixed(1)
      + '%;background:' + right + '" title="' + chartEsc(r.rightTitle || '') + '"></i></div>'
      + '</div>'
      + '<div class="cbar-value">' + chartEsc(r.value === undefined ? '' : r.value) + '</div>'
      + '</div>';
  });
  return html + '</div>';
}

// Two bars per label, for this-period-vs-last. The DELTA is supplied by the caller rather
// than computed here on purpose: subtracting across two different measurement bases is a real
// defect this repo has already recorded, and this file will not do that arithmetic blind.
function chartPaired(rows, opts) {
  opts = opts || {};
  var basis = opts.basis || chartBasis(null);
  var aC = chartColor(opts.aToken || '--green', '#34d399');
  var bC = chartColor(opts.bToken || '--muted', '#9a9aa4');
  var max = chartNiceMax(Math.max.apply(null, [0].concat((rows || []).map(function (r) {
    return Math.max(chartNum(r.a, 0), chartNum(r.b, 0));
  }))));
  var cls = 'cbar-paired' + (basis.measured ? '' : ' unmeasured');
  var html = '<div class="' + cls + '">';
  (rows || []).forEach(function (r) {
    html += '<div class="cbar-row">'
      + '<div class="cbar-label">' + chartEsc(r.label) + '</div>'
      + '<div class="cbar-pair">'
      + '<i class="a" style="width:' + ((chartNum(r.a, 0) / max) * 100).toFixed(1)
      + '%;background:' + aC + '" title="' + chartEsc(r.aTitle || '') + '"></i>'
      + '<i class="b" style="width:' + ((chartNum(r.b, 0) / max) * 100).toFixed(1)
      + '%;background:' + bC + '" title="' + chartEsc(r.bTitle || '') + '"></i>'
      + '</div>'
      + '<div class="cbar-value">' + chartEsc(r.value === undefined ? '' : r.value) + '</div>'
      + '</div>';
  });
  return html + '</div>';
}

// A swatch legend. One implementation, so a chart and its key cannot drift apart.
function chartLegend(items) {
  var html = '<div class="cbar-legend">';
  (items || []).forEach(function (it) {
    var color = it.token ? chartColor(it.token, it.fallback || '#9a9aa4') : (it.color || '#9a9aa4');
    html += '<span class="cbar-key"><span class="sw" style="background:' + color + '"></span>'
      + chartEsc(it.label) + '</span>';
  });
  return html + '</div>';
}

// The sentence a shape must carry when its figures are not provider-measured. Returned rather
// than rendered so the caller places it in its own caption, but WORDED here so every panel
// says the same thing about the same state.
function chartBasisNote(basis) {
  if (!basis || basis.basis === 'count') return '';
  if (basis.measured) return '';
  if (basis.basis === 'none') return 'No call behind these figures could be priced.';
  if (basis.basis === 'unknown') {
    return 'This gateway does not report whether these dollars came from provider-reported '
      + 'usage, so they cannot be shown as measured.';
  }
  return 'Reconstructed from the request body, not from provider-reported usage.';
}
