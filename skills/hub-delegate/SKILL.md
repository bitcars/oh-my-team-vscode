---
name: hub-delegate
description: "For the lab hub only: hand detail work to delegates that return a short, quotable result — the suites on a team's final tree (rerun.sh), a team document checked against its reference or a status draft (the oh-my-team:hub-reader agent), and ledger rows and the Now block (ledger.sh). The hub still sends every message, rules every gate and holds every tap."
---

# Hub delegation

Your context keeps gates, rulings and taps; the delegates keep the material behind them. Read and
Write don't expand variables: get the real paths in Bash first, with `echo "$OMT_PLUGIN_DIR"` and,
for the vault, your Vault row's `V=` line followed by `echo "$V"`. The rules are in the spec, §0a
"Delegation", §1.8 and §4.1; this file says how. Fork trees only (spec §1.10, the fork's list).

## 1. Ledger rows and the Now block: ledger.sh

    bash "$OMT_PLUGIN_DIR/skills/hub-delegate/ledger.sh" "<ledger>" log "<text>"
    bash "$OMT_PLUGIN_DIR/skills/hub-delegate/ledger.sh" "<ledger>" now "<file>"
    bash "$OMT_PLUGIN_DIR/skills/hub-delegate/ledger.sh" "<ledger>" show

- `log` appends `- <stamp> <text>`; the script takes `date -u` itself, so never type a stamp.
- `now` replaces the lines between `## Now` and `## Log` with `<file>`'s lines: at most 15, none
  over 1000 bytes, no CR, and a State the hook can read (`State: <NAME>.` after ". " or at a line
  start, not in quotes). Make a dir with `mktemp -d /tmp/hub-now-XXXX`, echo it, then Write
  `<that dir>/now.md` (a new file, so Write needs no Read first).
- `show` prints the Now block and the last 12 Log rows; `show N` the last N (1-99).
- It writes only an existing `LWO-NNN-<slug>.md` in `<vault>/lab/tasks/`; you create the ledger
  yourself, with Write, when you take its number.
- Run ledger.sh calls one after another in one Bash call, chained with `&&`, never as parallel
  tool calls: two at once can lose a row. After an exit 3, `show` before any further call.
- Read its output: `stamp:`, `sha1-before:`, `sha1-after:` and the diff are tool output. Exit 2
  wrote nothing (`L<n>: <reason>` says why); exit 3 restored the old bytes or, with L13, found the
  file changed under it: `show` and fix by hand. Before an ask or a ruling, `show` the ledger, so
  the Now block you rely on is the one in the file.

## 3. A team document against its reference, and the operator draft: hub-reader

Run `shasum` on the reference and the document, and compare the document's with the sha1 in the
team's message; a different value: ask the team before the check. Then spawn the
`oh-my-team:hub-reader` agent with the Agent tool. Fill
`"$OMT_PLUGIN_DIR/skills/hub-delegate/briefs/check.md"` or `briefs/draft.md` (your plain-words
status for the operator), every slot. The reference, by kind of document:
- a restatement: the issue body. Make a dir with `mktemp -d /tmp/hub-issue-XXXX`, echo it, then
  `gh issue view <n> -R bitcars/<repo> --json body -q .body > <that dir>/issue.md`;
- a DONE report: the plan, or both files of a two-part plan;
- a set of review verdicts (`<lwo-nnn>-review-r<n>.md`): the plan.

- A check returns one row per side: `<id> | match|mismatch|plan|absent | <path>:<line> | <line>`
  (the line is the rest after the third ` | `: the file's whole line, leading spaces kept), and
  a `COUNT` line.
- Before you rule, count the ids against the items you gave; a missing id means the check failed.
  Re-check every mismatch and absent row, and one match row, yourself:

      grep -nxF -e '<line>' -- "<path>"

  One hit's line number must equal the row's (write a `'` in the line as `'\''`); a repeated line
  is reported with all its line numbers. A whitespace difference is a mismatch. 0 hits, or line
  numbers other than the row's: "not confirmed", read that line yourself. A CRLF document
  (`grep -c $'\r' -- "<path>"` above 0): read the lines yourself. For an absent
  row, grep the item's id or key term in the document (`grep -n -i -e '<id>' -e '<term>' --
  "<doc>"`): no hit confirms it; a hit is "not confirmed": read that line yourself. Cite your
  grep lines, not its words.
- A draft returns with the ledger lines it drew on. Read it, change what you would say
  differently, and send it yourself.

## 4. What never leaves your context

Every message, ruling and tap; your rulings on the gates (a reviewer's verdict file may be checked by hub-reader) and plan v2; `git diff --cached --stat` and
`--name-only`; the staged sha1 (computed by you, compared with the team's); the push-set hashes and
the two evidence commands; ls-remote; gh pr view and the merge; reading rerun.sh's summary; the
grep re-checks; the live check; creating a ledger; the words of its CLOSED row.

## 5. Isolation, and what it is not

- hub-reader has Read, Grep and Glob only: no Bash, no Write, no bridge tool, no Agent. Probed on
  claude 2.1.316: `briefs/reader-probe.txt`.
- rerun.sh runs each suite from `env -i` with run.sh's shims (omt, gh and claude refused by name;
  git push refused; curl to the hubs' ports refused; tmux confined to `<D>/tmux` except the
  harness's `-L omtv-test-*`), on a /tmp clone with no remotes. The test harness still runs its own
  sandboxed claude by absolute path (CLAUDE_BIN). rerun.sh never kills outside `<D>`: the
  harness's own servers and sandboxes are the harness's cleanup.
- ledger.sh calls only node, to read the State with the hook's own function, and writes one file.
- Not a sandbox: a test's own code can still reach the network or any file by absolute path, as
  under run.sh.
