# Changelog

What changed in each release, described as something you'd notice using the product — not
internal refactors. Dates are the dates each version was published. Several entries are
corrections that make Cheaper's reported savings **smaller**: the old numbers were wrong,
and we would rather say so plainly than quietly ship different figures. The current release
is `cheaper@0.4.2`.

## 0.4.2 — 2026-08-19
`npx cheaper install --all` now installs the `cheaper` command it spends the rest of its
output telling you to run.

- **`cheaper install` and `cheaper install --all` now install the CLI launcher.** They did
  not, and the install that followed reported nothing but green ticks and then did not
  work: the very first command it printed — `cheaper gateway start` — failed with
  `zsh: command not found: cheaper`. The invisible half was worse. The same run writes the
  literal string `cheaper peek --tagline …` into the global-instructions file of every
  harness it detects, so an install that printed "✓ tagline wired" for Codex, Copilot and
  the rest had in fact wired instructions that could never execute, and nothing would ever
  have reported it. A launcher is one file and it is ours to write, so it is no longer
  optional. `autostart` remains opt-in and is still unreachable from `--all`.
- **The autostart question is no longer asked when it cannot be answered.** It was offered
  whenever the gateway installed, but a login entry points at the stable CLI copy at
  `~/.cheaper/cli`; without it, answering yes returned `✗ nothing to autostart`. Because
  the answer is remembered per machine, that spent the one question this install ever asks
  on an outcome already known to fail.

## 0.4.1 — 2026-08-10
Cheaper can start itself at login and survive a reboot, and it has stopped claiming success
it never checked.

- **Cheaper can now start itself at login, if you ask it to.** `cheaper autostart enable`
  registers a per-user login entry — a LaunchAgent on macOS, a systemd user unit on Linux, a
  Scheduled Task on Windows — that starts the gateway and brings it back if it crashes.
  Nothing came back after a reboot before this. It is **opt-in only**: neither
  `cheaper install` nor `cheaper install --all` can ever register it, you have to name it.
  `cheaper autostart disable` deregisters the entry and deletes the file it wrote, and
  `cheaper autostart status` re-checks that the paths it recorded still exist, so upgrading
  Node no longer leaves a login entry crash-looping in silence.
- **The end-of-chat line no longer shows a dashboard link when the gateway isn't running.**
  It used to print the dashboard address on every chat without ever checking it, so clicking
  it gave a connection error. The link now appears only when the gateway actually answered.
- **An unreachable gateway now says so.** When Cheaper can't reach the gateway it falls back
  to estimating from your local chat history — and it used to do that silently, while a
  gateway that answered with stale data got a visible warning. The unreachable case now gets
  a notice of the same weight, naming the port it tried.
- **`cheaper gateway start` no longer reports success for a gateway that died.** If a second
  gateway couldn't claim the port and exited immediately, the command still printed a green
  "started" tick — and `cheaper gateway stop` afterwards could no longer reach the real one.
- **`cheaper status` no longer shows a stopped gateway in green.** It was already asking the
  gateway whether it was alive, then colouring the answer as though it were.
- **`cheaper gateway stop` now confirms it is stopping Cheaper's gateway.** After a reboot
  the recorded process id can belong to something else entirely, and stopping the gateway
  could have signalled an unrelated program. If that check can't be made, the command
  refuses to act rather than assume.
- **A real `--port` flag,** plus `cheaper gateway restart` and `cheaper gateway serve` for
  running the gateway in the foreground under a supervisor. The dashboard launcher, the
  freshness checks and the end-of-chat line now all use the port the gateway actually bound
  instead of assuming 8787 — which matters as soon as autostart picks 8788 because 8787 was
  busy.
- **`cheaper status` now re-checks everything the installer wrote,** not just one of the six
  places. Five of them were never re-verified, which is why switching accounts in your
  coding tool could break the setup with nothing reporting it.
- **Mistral requests are answered by the tier they were sold as.** The middle slot held a
  model catalogued a tier below it and the top slot a mid-capability model, so a mid-tier
  request was answered one tier down, and a hard request that escalated was answered by a
  mid-capability model while being reported as top tier. The corrected top-tier target is
  both more capable and cheaper than the one it replaced.
- **Every price in the catalog was re-read against its vendor's own page.** 71 of 75 rows
  could be checked against a live pricing sheet and every one of them already matched, to
  the cent. What was missing was **six OpenAI long-context tiers** the vendor publishes and
  Cheaper did not carry — an undercount on exactly the long inputs where the rate changes.
- **`cheaper peek` now reports how many calls were actually re-routed,** beside the existing
  count of calls that were eligible for a cheaper tier. Those are two different sets, and
  showing only the second invited you to derive the dollars from a number the dollars don't
  come from. A `Routing` line appears only when the two counts differ — that is, exactly
  when reading them as one number would mislead you.
- **A route whose target has no published price is now named and counted.** It moves no
  money, which is correct, but that left a `0` you couldn't tell apart from a measured one.
  Cheaper now says which models need a price, and a report written before these counters
  existed shows a dash rather than a fabricated zero.
- **Status labels in the savings report say what they mean.** A window whose figures can't
  be published — because the store's own state couldn't be read — was rendered in the same
  visual weight as a mild "these figures are provisional", and two statuses explained
  themselves by repeating their own name.
- **Linux downloads are current, and arm64 is a first-class target.** The Linux `.deb`,
  `.rpm` and `.AppImage` downloads had been serving the **0.1.0** build for days, and the
  Windows installer was three days old; all now serve the current release. New
  `arm64` `.deb`, `.rpm` and `.AppImage` builds ship alongside them.
- **AppImage downloads are linked from the site.** They were being published and never
  offered anywhere you could see them, on either the download page or the thank-you page,
  with per-architecture install steps.
- **Cheaper stops overstating what it is wired into.** A menu entry named a desktop app it
  has no integration with — every path it touches belongs to the Codex command-line tool, so
  it says `Codex CLI` now, and two neighbouring labels had the same overclaim. The
  documentation now says where you first meet it that routing is opt-in in every tool,
  including Claude Code, and the end-of-chat line no longer credits Cheaper for a tool's own
  model choices when it was never routing them.

## 0.4.0 — 2026-08-08
The router stops ratcheting up to the priciest model, and the dashboard stops publishing
unmeasured arithmetic under a headline that reads as measured.

- **Routing now looks only at your current message,** not your whole conversation history or
  either side's system prompt. The old router classified the entire transcript every time,
  so one matching word anywhere in a chat pinned every later turn to the most expensive tier
  for the rest of that conversation — a one-way ratchet that never came back down. Replayed
  over roughly 47,000 real calls, the old behavior routed 89.9% of traffic to the top tier
  and saved 2.03%; scoping the classifier to the current turn took the same traffic to 28.7%
  saved.
- **The cheap triage classifier was reading the wrong end of your chat.** With the whole
  conversation concatenated, the text it actually saw was the system prompt and the oldest
  messages — the request it was supposed to classify had been truncated away entirely.
- **The gateway now refuses to substitute a different vendor's model.** A request naming one
  company's model could previously be served a different vendor's model, and the call would
  succeed with nothing in the response indicating the swap — so a harness comparing vendors
  through Cheaper was measuring the same vendor every time.
- **The "never spend more than the model you asked for" ceiling now covers every model.**
  It had no effect for 62 of 89 model ids, because Cheaper couldn't place them in a tier and
  no tier meant no ceiling. A cheap model paired with a hard question was being upgraded on
  a setup where upgrades are switched off.
- **Hard, correctness-critical requests** (concurrency, security, proofs and similar) are
  protected from being downgraded to save money. This is a downgrade veto, not an upgrade:
  Cheaper still never routes a request to a model pricier than the one you asked for.
- **A saving is no longer picked for having the friendlier sign.** When the measured figure
  and the estimated one disagreed, Cheaper chose between them by which was larger — so a
  measured **loss** of $2.00 could print as "saved about $84.00" and write $84 into your
  lifetime total.
- **A call the price catalog can't value is no longer counted as spend.** It was being added
  to `Spent` at *today's* rate, which is wrong for anything priced under a promotion that
  has since expired, and moves on its own when a promotional window opens or closes. It is
  now excluded from every dollar total and counted only in a named exclusion bucket, so the
  dollars and the call counts reconcile.
- **`vs all-frontier` can show a loss.** It was floored at $0.00, so a period where routing
  cost more than the all-frontier baseline read as an honest, measured break-even. A real
  negative is now shown as one.
- **`cheaper peek` reads your live gateway settings instead of assuming the defaults.**
  Measured against one real history on the same day, the difference was **$470 of
  over-claim, 6.2%** — Cheaper was pricing the middle tier against a model on a promotional
  rate while the gateway was actually routing to a different, list-priced one. An
  unreachable gateway is now an answer ("assuming defaults"), not an error, and the
  assumptions it made are listed.
- **Models Cheaper can't route are moved out of the headline, not zeroed.** Four of six
  model families have no routing endpoint at all; their spend still counts toward what you
  paid, and their savings are reported separately instead of quietly inflating the top-line
  number.
- **The dashboard's headline can no longer be read as measured by accident.** On one real
  machine, 90 of 94 recorded calls were probes that returned no output tokens, and the
  measured path had never once fired — yet the whole figure was published under a headline
  that reads as measured. Cheaper now publishes how many calls were measured against how
  many weren't, explains the wall of `$0.00` in the log rather than papering over it, and
  a figure with no measured basis has to be asked for by name.
- **"Live" now means data arrived, not that a socket is open.** An idle gateway looked
  identical to a busy one. Cheaper now reports how old the newest call is, and an empty
  store says so instead of showing a fabricated zero.
- **The desktop app no longer leaks its access token into browser history.** "Open dashboard
  in browser" was putting a long-lived token in the address bar; internal windows now pass
  it invisibly.
- **The desktop app adopts a gateway it left behind.** A crash or force-quit used to strand
  the gateway holding the port, after which the next launch could neither stop nor restart
  it while the menu bar read "Gateway: stopped".
- **The desktop app updates itself,** and only pages Cheaper serves can reach its privileged
  bridge — any link, redirect or script-driven navigation previously carried it to whatever
  page loaded next.

## 0.3.0 — 2026-08-07
Savings are recorded per call at the time the call happened, priced from a real per-model
catalog, and a period Cheaper can't vouch for says so instead of showing $0.00.

- **Retired Opus pricing was being applied to current Opus work.** A single hardcoded rate
  bucket valued all top-tier Anthropic usage at Claude Opus 4's retired rate, 2.74× the real
  cost of Opus 5. Replaced with a per-model price catalog transcribed from each provider's
  own pricing page, with the transcription date recorded.
- **An unrecognized model no longer inherits a neighboring model's price.** Matching used to
  fall back to the nearest older entry, so a newly released model silently adopted a retired
  rate. Matching is now exact; a model with no published price is unpriceable and
  contributes $0, never a guessed rate.
- **Savings are computed in dollars from the catalog,** not inferred from a model's name.
  Name and price disagree in 38 places in the current catalog, and the two approaches had
  drifted far enough apart that the same session could report **$24.00 or $84.00 purely
  from the order lines appeared in the log file**.
- **Cache, long-context, batch and promotional rates are modeled per model** — including
  Anthropic's 1-hour cache-write rate, which is what Claude Code actually uses and was
  previously undercounted. Promotional windows are evaluated against the date each call
  happened, so a launch price that ends doesn't get quoted forever.
- **The gateway prices a routed call at the exact model it served,** not a tier-average
  stand-in — the earlier approach could over-report by roughly 50% on some calls.
- **Cache-aware pricing on your local chat history.** Transcripts fold cached input into the
  plain input count, and Cheaper was charging all of it at full rate — inflating one live
  session's total roughly 7× ($1,038 against a real $148), and its savings with it.
- **Savings are tracked per call, by when the call happened** — not per chat, by when the
  end-of-chat summary last printed. The old ledger could report 100% of lifetime savings
  under "today" for work spanning weeks, and re-running an old chat's summary moved its money
  into a different day. Period columns now partition history instead of nesting, so they add
  up to your lifetime total rather than counting today six times.
- **Streamed calls are finally measured.** Claude Code always streams, and the gateway
  parsed no token usage at all on that path — every streamed call was stored as a
  character-count guess. It now reads the provider's own usage data out of the stream.
- **Retries are never priced.** An automatic retry after a rate-limit used to be recorded as
  a separate priced call, so a retry storm could book the same saving several times over for
  one delivered answer.
- **A period Cheaper can't vouch for shows a labelled reason, never $0.00** — a range before
  the store was watching, a partly covered range, a window where more than 20% of tokens are
  unpriceable, or a session you deleted with `cheaper forget`. Measured and estimated
  figures are never added together; they get separate columns.
- **The end-of-chat line names models, not tiers.** "12 calls on claude-sonnet-5 instead of
  claude-opus-5" is checkable; "sonnet tier instead of opus" was not. "You spent $X" is gone
  — most sessions run against a flat-rate plan where that sum is never charged, so the line
  reports the metered value at list API rates instead. A running lifetime total was added,
  and it is signed: a chat where routing cost extra now subtracts, where it used to only
  ever ratchet upward.
- **The gateway's dashboard and other local read endpoints now require a per-machine
  token.** Loopback isn't a trust boundary on a shared machine — any other account could
  read your full usage record. Run `cheaper dashboard` and it mints the token and opens the
  tokened address for you. Exports guard against spreadsheet formula injection.
- **New commands:** `cheaper import`, `cheaper forget`, `cheaper compact`, `cheaper export`,
  and `cheaper logs / reports / monitor / dashboard`, each with a `--json` or `--terminal`
  option. New surfaces: a rebuilt logs register and reports tab, and a `cheaper://` link that
  opens the desktop app on the right tab even from cold.
- **A "savings" figure on the marketing site was generated at random.** It incremented on a
  timer, reset on page load, and was never connected to any data. It has been removed. The
  savings calculators now state that they are illustrative, and the tool counts published
  across the site (36 with documented setup, 8 detected, 7 read) are reconciled instead of
  being quoted five different ways.

## 0.2.2 — 2026-08-06
Every chat ends with a branded, per-chat savings line.

- **A "Cheaper.app saved $X and N tokens…" line at the end of every chat,** wired into
  Claude Code, Codex, Cursor, Copilot, Gemini, Grok, OpenCode and PI.dev. It is exact when
  the gateway served the calls and marked as an estimate when it is read from your local
  transcript, and it never claims a phantom, sub-cent or zero-token saving.
- **A chat's sub-agents are credited to that chat.** Delegated work runs on cheaper models
  and was being left out entirely, so a chat that delegated heavily reported "no cheaper
  routing warranted" or $0 while it was saving real money.

## 0.1.0 — 2026-08-06
First release.

- **Gateway:** an Anthropic- and OpenAI-compatible routing proxy with a local monitor and
  dashboard.
- **Router:** content-based tiering with a requested-model cost ceiling by default — Cheaper
  only downgrades or matches, it never spends more than the model you asked for.
- **CLI:** `cheaper install` (skill / hook / plugin / gateway), `gateway`, `monitor`,
  `status`, and `cheaper peek`, which reads your existing chat history and estimates what
  routing would have saved before you install anything.
- **Plugin:** a skill, an always-on hook, and three tiered agents.
- **Desktop:** a menu-bar app with a live monitor, which start/stops the gateway and shows
  savings as they happen.
