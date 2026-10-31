# rerun.sh: the hub's re-run of a team's staged change, no model (#69 item A, A1). Run it with
# bash; mode 644.
#
#   bash rerun.sh <D> <tree> <base-sha> <staged-sha1> <suites-file>     # launcher (the hub's call)
#
# The launcher checks its arguments and <D>, cleans <D>, starts the run detached in its own session
# and prints `pid: <N>` and `out: <D>/out`. The run (`--run`, never typed by the hub) checks the tree
# (R2, R5, R6, R3), copies it and runs the suites, then writes out/summary.txt, out/rc.txt and
# out/done, in that order. Fork trees only. Every git call is /usr/bin/git (PATH's git may be a shim).
# No lock: one launcher per <D> at a time (the hub calls it serially).

export LC_ALL=C
set -u

# Each git call on the team's tree runs with the prefix
#   GIT_CONFIG_PARAMETERS=$NOEXEC GIT_ATTR_SOURCE=$ATTR_SOURCE GIT_NO_LAZY_FETCH=1 \
#   GIT_NO_REPLACE_OBJECTS=1 /usr/bin/git -C …
# and each diff adds --no-ext-diff --no-textconv. What that closes: the fsmonitor and hook commands;
# external diff, textconv and diff.<drv>.command; filter clean/process drivers from .gitattributes
# and core.attributesFile (attributes are read from the empty tree; the common dir's
# info/attributes, still read, is refused by R6 unless it is a regular file setting no filter); lazy
# fetches in a partial clone (GIT_NO_LAZY_FETCH; the file, ssh and ext protocols are also refused);
# a submodule's own config and attributes (R6 allows only file and symlink modes in the index and
# HEAD, and R6's worktree diff ignores submodules; the submodule keys are pinned too); replace refs;
# and the config that reshapes a patch, by the listed pins. GIT_CONFIG_PARAMETERS outranks every
# config file and include. Per call, never exported, so the suites' env stays as §2.4 builds it.
# These two values and that prefix are the one source: the hub's staged-sha1 command copies them
# byte-equal.
NOEXEC="'core.fsmonitor=false' 'core.hooksPath=/dev/null' 'core.attributesFile=/dev/null' 'protocol.allow=never' 'protocol.file.allow=never' 'protocol.ssh.allow=never' 'protocol.ext.allow=never' 'color.ui=never' 'color.diff=never' 'diff.noprefix=false' 'diff.mnemonicPrefix=false' 'diff.srcPrefix=a/' 'diff.dstPrefix=b/' 'diff.context=3' 'diff.interHunkContext=0' 'diff.relative=false' 'diff.orderFile=/dev/null' 'diff.algorithm=myers' 'diff.indentHeuristic=true' 'diff.suppressBlankEmpty=false' 'diff.renames=true' 'diff.renameLimit=1000' 'diff.submodule=short' 'diff.ignoreSubmodules=none' 'submodule.recurse=false' 'core.quotePath=true'"
ATTR_SOURCE=4b825dc642cb6eb9a060e54bf8d69288fbee4904 # the empty tree

# A name as it goes into summary.txt: one holding any byte outside printable ASCII (0x20-0x7e) is
# written escaped by printf %q, all on one line, so no reader's line splitting (\n, \r, U+2028, NEL)
# can make it start a line of its own.
esc() { case "$1" in *[!\ -~]*) printf '%q' "$1" ;; *) printf '%s' "$1" ;; esac; }

# ── run mode ─────────────────────────────────────────────────────────────────
if [ "${1-}" = --run ]; then
  [ "$#" -eq 6 ] || exit 2
  # A git location in the hub's own env would bind the checks to another repo.
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES \
    GIT_COMMON_DIR GIT_NAMESPACE GIT_CONFIG_COUNT GIT_DIFF_OPTS GIT_EXTERNAL_DIFF
  D=$2 TREE=$3 BASE=$4 SHA=$5 SUITES=$6
  cd -- "$D" || exit 2
  echo $$ > out/pid.tmp && mv out/pid.tmp out/pid || exit 2

  # Harness names (Q1, C3-3): the machine-wide sets, before and after.
  harness_dirs() { ls -d /private/tmp/omt-wo021-* /private/tmp/omt-claude-plugin-* 2>/dev/null | sort; }
  harness_servers() { pgrep -f -- '^[^ ]*tmux( [^ ]+)* -L omtv-test-' | sort; }
  DIRS_BEFORE=$(harness_dirs)
  SERVERS_BEFORE=$(harness_servers)

  RESULT=2
  PART2='rerun.sh: the run ended before a result'

  # The names in $2 (after) that are not in $1 (before), each through esc, space-separated, or (none).
  new_names() {
    local x='' n
    while IFS= read -r n; do
      x+="$(esc "$n") "
    done < <(comm -13 <(printf '%s\n' "$1" | sed '/^$/d') <(printf '%s\n' "$2" | sed '/^$/d'))
    x=${x% }
    [ -n "$x" ] && printf '%s' "$x" || printf '(none)'
  }

  finish() {
    trap '' TERM INT HUP
    # Reap the run's own group on every exit path, by exact pid (E2-2, N1). The list also holds
    # this $(…) subshell and its grep, gone before the TERM; signalling a dead pid is a no-op.
    local p pids live i
    pids=$(pgrep -g $$ | grep -vx -- "$$")
    for p in $pids; do kill -TERM "$p" 2>/dev/null; done
    for ((i = 0; i < 100; i++)); do
      live=''
      for p in $pids; do kill -0 "$p" 2>/dev/null && live+="$p "; done
      [ -z "$live" ] && break
      sleep 0.1
    done
    for p in $pids; do kill -0 "$p" 2>/dev/null && kill -KILL "$p" 2>/dev/null; done
    local dirs_after servers_after log logsha
    dirs_after=$(harness_dirs)
    servers_after=$(harness_servers)
    if [ -f out/log.txt ]; then
      log="$D/out/log.txt"
      logsha=$(shasum out/log.txt | cut -c1-40)
    else
      log='(none)' logsha='(none)'
    fi
    : > out/summary.txt
    # §2.5 part 1 (the log.txt copy, appended with >>) goes here: subtask S03.
    {
      [ -n "$PART2" ] && printf '%s\n' "$PART2"
      printf 'harness-new: dirs %s; servers %s\n' "$(new_names "$DIRS_BEFORE" "$dirs_after")" \
        "$(new_names "$SERVERS_BEFORE" "$servers_after")"
      printf 'log: %s\nlog-sha1: %s\nrerun-rc: %s\n' "$log" "$logsha" "$RESULT"
    } >> out/summary.txt
    echo "$RESULT" > out/rc.txt
    date -u > out/done
  }
  trap finish EXIT
  # Only TERM reaches this trap: INT and HUP are ignored from the start (nohup, and a non-interactive
  # `&` child), and bash cannot trap a signal ignored at entry. The hub and the kit stop with TERM.
  trap 'RESULT=killed; PART2=""; exit' TERM INT HUP

  refuse_run() { # <result> <part-2 text>
    RESULT=$1 PART2=$2
    exit
  }

  # One git call on the team's tree, output to <out-file>. It runs in the background under `wait`, so a
  # TERM ends the run even while git blocks (bash runs a trap only after a foreground child exits).
  tg() { # <out-file> <args…>
    local out=$1
    shift
    GIT_CONFIG_PARAMETERS=$NOEXEC GIT_ATTR_SOURCE=$ATTR_SOURCE GIT_NO_LAZY_FETCH=1 GIT_NO_REPLACE_OBJECTS=1 /usr/bin/git -C "$TREE" "$@" > "$out" &
    wait $!
  }
  # tg's output files live in <D>/tmp (a cleaned name): removed at the end of R6 when it passes;
  # after a refusal the next launch's clean removes them.
  mkdir -p "$D/tmp" || refuse_run 2 'R2: no scratch dir'

  # ── R2: the tree's HEAD is the base, the tree is its worktree's top, not under <D> ──
  tg "$D/tmp/head" rev-parse HEAD 2>/dev/null && head=$(cat "$D/tmp/head") || head=''
  [ "$head" = "$BASE" ] || refuse_run 2 "R2: HEAD $(esc "${head:-(none)}") is not $BASE"
  treep=$(CDPATH='' cd -- "$TREE" 2>/dev/null && pwd -P) || refuse_run 2 "R2: no tree $(esc "$TREE")"
  tg "$D/tmp/top" rev-parse --show-toplevel 2>/dev/null && top=$(cat "$D/tmp/top") || top=''
  topp=$(CDPATH='' cd -- "$top" 2>/dev/null && pwd -P) || topp=''
  [ -n "$top" ] && [ "$topp" = "$treep" ] || refuse_run 2 "R2: tree $(esc "$treep") is not its worktree's top"
  case "$treep/" in "$D"/*) refuse_run 2 "R2: tree $(esc "$treep") is under $D" ;; esac

  # ── R5: the suites file (§2.3) ──────────────────────────────────────────────
  [ -f "$SUITES" ] && [ -r "$SUITES" ] || refuse_run 2 "R5: no suites file $(esc "$SUITES")"
  n=0 kept=0
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    case "$line" in *$'\r'*) refuse_run 2 "R5: CR in line $n" ;; esac
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    kept=$((kept + 1))
    if [ "$line" = 'channel bun test --isolate' ] || [ "$line" = 'channel tsc' ]; then
      continue
    fi
    if [[ "$line" =~ ^bun\ test(\ test/[A-Za-z0-9._/-]*)+$ ]] && [[ "$line" != *..* ]]; then
      continue
    fi
    refuse_run 2 "R5: bad line $n"
  done < "$SUITES"
  [ "$kept" -ge 1 ] || refuse_run 2 'R5: no suite'

  # ── R6: no unstaged change or untracked file outside the never-staged list ──
  never_staged() { # <path>
    case "$1" in .claude/* | CLAUDE.local.md | .mcp.json* | .sisyphus/*) return 0 ;; esac
    return 1
  }
  # The common dir's info/attributes is read even with the empty-tree attribute source: a filter set
  # there could run a command inside the diff below, so it is refused first, and so is anything there
  # that is not a regular file (a FIFO fails -f, so a bare -f test skipped it, and git's read blocks
  # on it).
  tg "$D/tmp/common" rev-parse --path-format=absolute --git-common-dir 2>/dev/null \
    || refuse_run 6 'R6: rev-parse failed'
  common=$(cat "$D/tmp/common")
  ia=$common/info/attributes
  if [ -e "$ia" ] || [ -L "$ia" ]; then
    { [ -f "$ia" ] && ! [ -L "$ia" ]; } || refuse_run 6 'R6: info/attributes is not a regular file'
    ! grep -q 'filter=' "$ia" || refuse_run 6 'R6: info/attributes sets a filter'
  fi
  # The repo-level config may hold only the keys a plain clone and its worktrees carry, and a few
  # ordinary ones; the list is deliberately tight, and any other key
  # (include.path and includeIf.*.path among them) is refused before the first diff. The pins in
  # NOEXEC stay as the second layer. Git lists section and name lower-case, a subsection as written.
  config_ok() { # <key>
    case "$1" in
      core.repositoryformatversion | core.filemode | core.bare | core.logallrefupdates | core.ignorecase \
        | core.precomposeunicode | core.worktree | remote.*.url | remote.*.fetch | remote.*.pushurl \
        | remote.*.tagopt | remote.*.prune | remote.pushdefault | branch.*.remote | branch.*.merge \
        | branch.*.rebase | branch.*.pushremote | branch.*.vscode-merge-base | fetch.prune | user.name \
        | user.email | extensions.worktreeconfig | gc.* | pull.* | push.* | init.*) return 0 ;;
    esac
    return 1
  }
  tg "$D/tmp/config" config --list --local -z || refuse_run 6 'R6: config --list failed'
  : > "$D/tmp/wtconfig"
  while IFS= read -r -d '' rec; do
    [ "${rec%%$'\n'*}" = extensions.worktreeconfig ] || continue
    tg "$D/tmp/wtconfig" config --list --worktree -z || refuse_run 6 'R6: config --list --worktree failed'
    break
  done < "$D/tmp/config"
  for f in config wtconfig; do
    while IFS= read -r -d '' rec; do
      key=${rec%%$'\n'*}
      config_ok "$key" || refuse_run 6 "R6: config key $(esc "$key") not allowed"
    done < "$D/tmp/$f"
  done
  # Only file and symlink modes are allowed in the index and in HEAD, before the first diff: git
  # takes any mode with the gitlink type bits (160000, or a non-canonical 160644) as a submodule, and
  # a diff runs git inside a submodule, which reads its own config and info/attributes. ls-files -s
  # and ls-tree read only the index and HEAD's trees and run nothing.
  tg "$D/tmp/index" ls-files -s -z || refuse_run 6 'R6: ls-files -s failed'
  tg "$D/tmp/headtree" ls-tree -r -z HEAD || refuse_run 6 'R6: ls-tree failed'
  mode_ok_index=$'^(100644|100755|120000) [0-9a-f]{40} [0-3]\t'
  mode_ok_head='^(100644|100755|120000) blob '
  for f in index headtree; do
    [ "$f" = index ] && ok=$mode_ok_index || ok=$mode_ok_head
    while IFS= read -r -d '' rec; do
      [[ "$rec" =~ $ok ]] && continue
      case "$rec" in
        16*) refuse_run 6 "R6: gitlink $(esc "${rec#*$'\t'}")" ;;
        *) refuse_run 6 "R6: mode $(esc "${rec%% *}") $(esc "${rec#*$'\t'}")" ;;
      esac
    done < "$D/tmp/$f"
  done
  # An index flag (assume-unchanged, skip-worktree: any tag but H) would hide a change from the diff;
  # M (unmerged) is refused here too.
  tg "$D/tmp/flags" ls-files -v -z || refuse_run 6 'R6: ls-files -v failed'
  while IFS= read -r -d '' rec; do
    case "$rec" in 'H '*) ;; *) refuse_run 6 "R6: index flag $(esc "${rec%% *}") $(esc "${rec#* }")" ;; esac
  done < "$D/tmp/flags"
  # Each list goes to a file first, so a git that fails is a refusal, never an empty list.
  tg "$D/tmp/r6-unstaged" diff --name-only -z --no-ext-diff --no-textconv --ignore-submodules=all \
    || refuse_run 6 'R6: diff --name-only failed'
  tg "$D/tmp/r6-untracked" ls-files --others --exclude-standard -z \
    || refuse_run 6 'R6: ls-files --others failed'
  bad=''
  NEVER_STAGED_CHANGES=''
  while IFS= read -r -d '' p; do
    if never_staged "$p"; then
      NEVER_STAGED_CHANGES+="$(esc "$p")"$'\n'
    else
      bad+="R6: unstaged $(esc "$p")"$'\n'
    fi
  done < "$D/tmp/r6-unstaged"
  while IFS= read -r -d '' p; do
    never_staged "$p" || bad+="R6: untracked $(esc "$p")"$'\n'
  done < "$D/tmp/r6-untracked"
  rm -f -- "$D/tmp/head" "$D/tmp/top" "$D/tmp/common" "$D/tmp/config" "$D/tmp/wtconfig" "$D/tmp/index" \
    "$D/tmp/headtree" "$D/tmp/flags" "$D/tmp/r6-unstaged" "$D/tmp/r6-untracked"
  rmdir -- "$D/tmp" || refuse_run 6 'R6: scratch dir not removed'
  [ -z "$bad" ] || refuse_run 6 "${bad%$'\n'}"

  # ── R3: the staged patch's sha1 ─────────────────────────────────────────────
  tg "$D/staged.patch" diff --cached --binary --no-ext-diff --no-textconv --submodule=short \
    || refuse_run 4 'SHA MISMATCH'
  got=$(shasum "$D/staged.patch" | cut -c1-40)
  [ "$got" = "$SHA" ] || refuse_run 4 'SHA MISMATCH'

  # ── the copy, R4 and the suites (§2.4) and summary part 1 (§2.5): subtask S03 ──
  # Until they land, a run that passes R3 fails closed: no suite has run, so there is no 0.
  refuse_run 5 'APPLY FAILED: copy and suites not built yet (S03)'
fi

# ── launcher mode ────────────────────────────────────────────────────────────
# R0: exactly five arguments; base and staged sha1 are 40 hex.
if [ "$#" -ne 5 ] || ! [[ "$3" =~ ^[0-9a-f]{40}$ ]] || ! [[ "$4" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'R0: usage' >&2
  exit 2
fi
self=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)/$(basename -- "$0")

# R1: <D> as run.sh checks it, re-typed; then no CLAUDE.md in <D> or above (G4).
# <D> is entered once and checked where it is, so the clean below acts on the dir that was checked.
case "$1" in /*) ;; *) echo "rerun.sh: give <D> as an absolute path" >&2; exit 2 ;; esac
CDPATH='' cd -- "$1" 2>/dev/null || { echo "rerun.sh: no dir $1" >&2; exit 2; }
D=$(pwd -P) || exit 2
case "$D" in /private/tmp/?*) ;; *) echo "rerun.sh: $D is not under /tmp" >&2; exit 2 ;; esac
case "$D" in *[!A-Za-z0-9._/-]*) echo "rerun.sh: $D has characters outside [A-Za-z0-9._/-]" >&2; exit 2 ;; esac
p=$D
while :; do
  for f in CLAUDE.md CLAUDE.local.md .claude/CLAUDE.md; do
    [ -e "$p/$f" ] && { echo "rerun.sh: refusing to launch, $p/$f exists" >&2; exit 3; }
  done
  [ -z "$p" ] && break
  p=${p%/*}
done

# Live-run guard (E2-3).
if [ -f "$D/out/pid" ]; then
  old=$(head -n 1 "$D/out/pid" | head -c 32 | tr -d '\n')
  if [[ "$old" =~ ^[1-9][0-9]*$ ]] && kill -0 "$old" 2>/dev/null; then
    echo "rerun.sh: run alive: $old"
    exit 2
  fi
fi

# Clean (G4), in the dir entered above.
rm -rf out w staged.patch shim-rerun home tmp tmux bun-cache tcache
mkdir out || exit 2

# Detach: a setsid child outlives the stop of the call that started it (S3, §7).
nohup /usr/bin/perl -MPOSIX -e 'POSIX::setsid()>=0 or die "setsid\n"; exec @ARGV' \
  /bin/bash "$self" --run "$D" "$2" "$3" "$4" "$5" </dev/null >"$D/out/launcher.txt" 2>&1 &

# Wait up to 5 s for the run's pid.
for ((i = 0; i < 50; i++)); do
  if [ -s "$D/out/pid" ]; then
    echo "pid: $(cat "$D/out/pid")"
    echo "out: $D/out"
    exit 0
  fi
  sleep 0.1
done
echo 'rerun.sh: run did not start'
exit 2
