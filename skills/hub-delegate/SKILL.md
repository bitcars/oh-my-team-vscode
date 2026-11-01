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

## 2. The suites on a team's final tree: rerun.sh

1. The team has staged its final files and reported `staged: <sha1>`. Compute it yourself in the
   team's worktree: `git -C "<team worktree>" diff --cached --binary | shasum`, and take the 40
   hex before the two spaces. A different value: no run; ask the team.
2. `<base sha>` is the full 40 hex: `git -C "<team worktree>" rev-parse <the plan's base>`.
3. Make a fresh dir for every launch with the line below (under /tmp, never `$TMPDIR`) and paste
   the printed path as `<D>`: `pwd -P` gives the `/private/tmp/…` form that rerun.sh passes to
   `--run`, which the wait lines test (a bare `mktemp -d /tmp/…` prints `/tmp/…`, which never
   matches).

       D=$(cd "$(mktemp -d /tmp/hub-rerun-<lwo-nnn>-XXXX)" && pwd -P); echo "$D"

   Write `<D>/suites.txt`, one suite per line, from these forms only: `bun test <test/…>…`, `channel bun test --isolate`, `channel tsc`.
4. Run it alone: no other root suite in any session (ask the team to hold its runs). Launch it
   with one ordinary Bash call; it detaches and prints `pid:`:

       bash "$OMT_PLUGIN_DIR/skills/hub-delegate/rerun.sh" "<D>" "<team worktree>" <base sha> <staged sha1> "<D>/suites.txt"

   No `pid:` line, or an exit other than 0: there is no run. Read the printed reason and
   `<D>/out/launcher.txt` if it exists. Exit 3 (a CLAUDE.md in `<D>` or above it): report it to the operator.
   Exit 2 with `run alive: <pid>`: a run is already going in that dir; wait on it.
   With a `pid:` line, log it at once:

       bash "$OMT_PLUGIN_DIR/skills/hub-delegate/ledger.sh" "<ledger>" log "rerun <D> pid <N>"

   Then write this line into the Now block, on its own line and with no `Waiting for:` words, so a
   rebuilt context can re-arm the wait from its mark:

       Rerun: <D> pid <N> mark 10800.

5. Wait with a Monitor, its timeout_ms parameter 1800000 (the tool's 30-minute cap; not the
   `timeout` command); re-arm it each time it expires until it prints an `END` line:

       D=<D>; a() { ps -ww -o command= -p "$(cat "$D/out/pid")" 2>/dev/null | grep -qF -- "--run $D "; }; until [ -e "$D/out/done" ] || ! a || [ $(( $(date +%s) - $(stat -f %m "$D/out/pid") )) -ge 10800 ]; do sleep 30; done; if [ -e "$D/out/done" ]; then echo "END done: $(tail -1 "$D/out/summary.txt")"; elif ! a; then echo "END dead: pid gone or not this run, no done, no run; group: $(ps -p "$(cat "$D/out/pid")" >/dev/null || pgrep -g "$(cat "$D/out/pid")" | tr '\n' ' ')"; else echo "END 3h: pid $(cat "$D/out/pid") alive, escalate"; fi

   Never sleep in the foreground, never use the `timeout` command. The line tests the run by its
   command (`ps -ww -o command= -p <pid>` holding `--run <D> `, with the space), never by `kill -0`: a pid that is
   gone or names another process is not this run. After a "wait" pick, the same
   line with `10800` replaced by the next mark (`21600` for 6 h, then `32400`, and so on).
   Write the current mark into the Rerun line each time. After a rebuild, re-arm by the Rerun line's form: `mark <S>` re-arms this line from that mark (never from 10800); `killed K=<K>` re-arms step 6's kill line with the `<K>` in `<D>/out/term-K` when that file exists, else the line's; ` asked 3h` or ` asked stuck-after-term` (an END whose pick is pending) re-tests `[ -e "$D/out/done" ]` and the run's command first; done or not this run: rewrite the line to `ended done.` or `ended dead.` first, withdraw the open ask in your next message, then go to step 7 or `END dead`; still this run: act on the operator's pick, never asking twice for one END; ` asked group-alive` re-runs the group test first (empty: `END group-empty`), then acts on the operator's pick, never asking twice; `ended` re-arms nothing, except `group-wait G=<G>` without ` asked`, which re-arms step 6's group-wait line with that `<G>`; never relaunch while that group lists a pid. More than one Rerun line: the last one written wins; delete the others.
   On every `END` line, before you act on it, rewrite the Rerun line: `END done` and `END dead` give `Rerun: <D> pid <N> ended <done or dead>.`; `END 3h`, `END stuck-after-term` and `END group-alive` add ` asked <END word>` before its final dot; `END group-empty` gives `Rerun: <D> pid <N> ended <abandoned or dead>.`; the Now block holds at most one Rerun line.
6. `END 3h`: escalate the stuck gate to the operator with the pid, `<D>` and the options (kill by that pid / wait); on the operator's pick "kill" run the kill call below once (it first checks for `<D>/out/done` and prints `END done` if the run has ended, which goes to step 7; then it checks the run's command, sends one TERM, never -9, and writes the TERM time to `<D>/out/term-K`), paste the printed `K=` number as `<K>`, log the TERM with ledger.sh, set the Rerun line to `Rerun: <D> pid <N> killed K=<K>.` (rewritten with each new `<K>`), and re-arm with the line below, which has no 3 h clause and ends 15 min after `<K>` (`rerun-rc: killed` is no run); on "wait" re-arm at the next mark, logging each mark's expiry (not each Monitor expiry) with ledger.sh; after a "wait" pick, an `END 3h` at a later mark is that mark's expiry: log it and re-arm at the next mark, do not ask again; without that pick never signal a run.

       D=<D>; if [ -e "$D/out/done" ]; then echo "END done: $(tail -1 "$D/out/summary.txt")"; elif ps -ww -o command= -p <pid> | grep -qF -- "--run $D "; then kill -TERM <pid>; K=$(date +%s); echo "$K" > "$D/out/term-K"; echo "K=$K"; else echo "END dead: pid <pid> is not this run"; fi

       D=<D>; K=<K>; a() { ps -ww -o command= -p "$(cat "$D/out/pid")" 2>/dev/null | grep -qF -- "--run $D "; }; until [ -e "$D/out/done" ] || ! a || [ $(( $(date +%s) - K )) -ge 900 ]; do sleep 30; done; if [ -e "$D/out/done" ]; then echo "END done: $(tail -1 "$D/out/summary.txt")"; elif ! a; then echo "END dead: pid gone or not this run, no done, no run; group: $(ps -p "$(cat "$D/out/pid")" >/dev/null || pgrep -g "$(cat "$D/out/pid")" | tr '\n' ' ')"; else echo "END stuck-after-term: pid $(cat "$D/out/pid") alive 15 min after TERM"; fi

   `END stuck-after-term`: first re-test `[ -e "$D/out/done" ]` and the run's command (done: step 7; not this run: `END dead`); still alive: log it with ledger.sh, quote `ps -o pid,stat,command -g <pid>` (a header-only quote means the group ended: read it as `END dead`), and escalate to the operator with two options, every time it happens: "re-arm 15 min" (a new `<K>` from `date +%s`, written to `<D>/out/term-K`, the Rerun line rewritten, the same line) and "abandon the run" (log `rerun-rc: killed`, no verdict for its suites, quote the group, signal nothing more); never -9, never a second TERM, never your own decision without the pick.
   After "abandon the run": no new rerun.sh until the group is empty; set the Rerun line to `Rerun: <D> pid <N> ended abandoned group-wait G=<G>.` (`<G>` from `date +%s`), run the group-wait line below, and ask the operator with two options, "you end the processes yourself" (by the pids quoted) and "wait, re-arm 15 min" (a new `<G>`, written into the Rerun line, the same line); `END group-alive`: add ` asked group-alive` to the Rerun line and ask the same two options again; send no other signal: never -KILL, never a second TERM, nothing else; on `END group-empty` (quote it) rewrite the Rerun line to `Rerun: <D> pid <N> ended <abandoned or dead>.`, log it with ledger.sh, and only then relaunch.

       D=<D>; G=<G>; g() { ps -p "$(cat "$D/out/pid")" >/dev/null && ! ps -ww -o command= -p "$(cat "$D/out/pid")" | grep -qF -- "--run $D " || pgrep -g "$(cat "$D/out/pid")"; }; until [ -z "$(g)" ] || [ $(( $(date +%s) - G )) -ge 900 ]; do sleep 30; done; if [ -z "$(g)" ]; then echo "END group-empty"; else echo "END group-alive: $(g | tr '\n' ' ')"; fi

7. `END done`: read `<D>/out/summary.txt`. Lines under `== <suite>` were copied from the harness
   with `grep -anE`; a summary line `Binary file … matches` or `copy: FAILED …` means the copy failed: no verdict for that suite;
   `rc=` is the suite's own exit code. Quote them. Count the reds from the ` N fail` line, and read
   the `(fail)` titles as a set: bun repeats them in an end list on long runs. `rerun-rc:` other
   than 0, or no `== ` line, means there was no run (a refusal: R2 base, R3 `SHA MISMATCH`, R4
   `APPLY FAILED`, R5 suites, R6 unstaged or untracked files; or `killed`): say so in the ask or ask the team, never quote a refusal as the run. `END dead`: no run either.
   The expected set is the `(fail)` lines the team's DONE report quotes whole (take them with `grep -aE '^\((fail|pass)\) ' -- "<DONE path>"`), plus rerun.sh's 4 scrub reds, which are red on every run under its fake HOME and are never re-run: `T4 profile guard > T4 HOME override without the seam gate still guards the passwd home's fleet dir`, `T14 test seams > T14 seams without the OMT_TEST_SANDBOX gate, or with a gate outside temp, are ignored`, `profile-mode removal control > baseline: the unmutated copy of test/omt-profile.test.ts passes (else HARNESS BROKEN)` and `profile-mode removal control > every title named by a mutant exists in its suite (else HARNESS BROKEN)`; compare by this rule: from each `(fail) ` line strip `(fail) ` and a trailing ` [<n>ms]` or ` [<n>s]`, then compare whole strings. If that grep finds no line, ask the team before step 8.
   For those 4, the team's DONE report must quote their `(pass)` lines whole from its own root run (real HOME, `env -u CLAUDECODE bun test test/`: bun prints no `(pass)` line while CLAUDECODE is set), as its order asks; check each with the line below, which takes only a line starting `(pass) ` (T4's, written out; the other three the same with their `<describe> > <title>`, a `'` written as `'\''` and each of `( ) . [ ] * + ?` written with a `\` before it) and the same strip rule on `(pass) `; without that, ask the team before the push ask.

       grep -nE '^\(pass\) T4 profile guard > T4 HOME override without the seam gate still guards the passwd home'\''s fleet dir( \[|$)' -- "<DONE path>"

   A ` N error` or ` N errors` line (N ≥ 1) under a suite (rerun.sh copies count lines only from bun's own summary block) is a loading failure: a file that threw hid its tests, so that suite has no verdict; never carry it as a red, and say so in the ask; `unhandled=` and `tcache-entries:` are information only.
   A `bun test` suite whose lines hold other than exactly one `Ran …` line and exactly one ` N fail` line, or an `rc=` other than 0 or 1, has no verdict either (bun killed mid-run, a path that matched no file, a summary block that was not copied, or a second block a test printed, such as a removal control echoing a nested `bun test`); never read its `(fail)` lines as its reds, and say so in the ask (send a nested block's `(fail)` lines to the team); this holds for step 8's re-run too.
   A `channel tsc` suite prints no `Ran` or count line and is read by its `rc=` and its `error TS` lines, the only lines of its output the summary copies: `rc=0` with no `error TS` line is green; `rc=2` with one or more `error TS` lines is red, each `error TS` line a red; anything else is no verdict, including `rc=2` with no `error TS` line and `rc=0` with an `error TS` line.
   If it is the channel suite, the first match wins: a `channel warm-up:` line with `rc=` neither 0 nor 1, or with `ran=0`, is the environment, report it to the operator; else a warm-up `errors=` other than the last run's on the same tree is a change, send it to the team (the channel suite's non-isolated pass errors on the router's module-cache port: 1 on master; `--isolate` is the verdict); else a ` N error` line in the `--isolate` part: after this run's `END done`, relaunch once as in steps 3–4 (a new dir by step 3's `D=$(cd "$(mktemp -d /tmp/hub-rerun-<lwo-nnn>-XXXX)" && pwd -P)`, its own ledger row and Rerun line) with suites.txt holding only `channel bun test --isolate`, never two rerun.sh runs at once, and quote the root suites from the first run; a clean relaunch: its channel lines are the channel verdict, quote them; a ` N error` line again (any N ≥ 1): send it to the team as a defect with both summaries, and say so in the ask. A ` N error` line under any other suite: send it to the team as a defect.
   The `channel warm-up:` and `tcache-entries:` lines and `out/warmup.txt` are not counted; the warm-up line's `errors=` and `ran=` are read only by the line above.
   `harness-new: dirs <names>; servers <pids>` other than `(none)` names what the test harness
   left behind: a leak by the harness, not a failure of the run; name it in your re-run message.
   `END dead` with a non-empty `group:` is an orphaned suite: report those pids to the operator,
   set the Rerun line to `Rerun: <D> pid <N> ended dead group-wait G=<G>.`, run step 6's
   group-wait line with the same two options as after "abandon", and don't relaunch before
   `END group-empty`.
8. A red outside the expected set: re-run each file with such a red through rerun.sh, alone, once, in a fresh dir made by step 3's line (`D=$(cd "$(mktemp -d /tmp/hub-rerun-<lwo-nnn>-XXXX)" && pwd -P)`), with one `bun test test/<file>` line. The same title red again (the expected set still applies): a real red. Green alone (with a verdict by step 7): a flake; log both summaries with ledger.sh, and your verdict says "flake, ruled by the hub". No third run.
9. The first lines of `<D>/out/log.txt` list the staged files, forbidden paths, never-staged
   changes and footer lines; read them with `head` or `grep -a`, not the whole log (a test can print
   binary bytes into it). Copy the summary
   to `"<vault>/lab/artifacts/<lwo-nnn>-rerun.txt"`.

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
