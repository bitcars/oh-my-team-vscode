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
# the config that reshapes a patch, and the eol conversion a global core.autocrlf would add to w's
# checkout and apply, by the listed pins. GIT_CONFIG_PARAMETERS outranks every
# config file and include. Per call, never exported, so the suites' env stays as §2.4 builds it.
# These two values and that prefix are the one source: the hub's staged-sha1 command copies them
# byte-equal.
NOEXEC="'core.fsmonitor=false' 'core.hooksPath=/dev/null' 'core.attributesFile=/dev/null' 'protocol.allow=never' 'protocol.file.allow=never' 'protocol.ssh.allow=never' 'protocol.ext.allow=never' 'color.ui=never' 'color.diff=never' 'diff.noprefix=false' 'diff.mnemonicPrefix=false' 'diff.srcPrefix=a/' 'diff.dstPrefix=b/' 'diff.context=3' 'diff.interHunkContext=0' 'diff.relative=false' 'diff.orderFile=/dev/null' 'diff.algorithm=myers' 'diff.indentHeuristic=true' 'diff.suppressBlankEmpty=false' 'diff.renames=true' 'diff.renameLimit=1000' 'diff.submodule=short' 'diff.ignoreSubmodules=none' 'submodule.recurse=false' 'core.quotePath=true' 'core.autocrlf=false' 'core.eol=lf'"
ATTR_SOURCE=4b825dc642cb6eb9a060e54bf8d69288fbee4904 # the empty tree

# A name as it goes into summary.txt: one holding any byte outside printable ASCII (0x20-0x7e) is
# written escaped by printf %q, all on one line, so no reader's line splitting (\n, \r, U+2028, NEL)
# can make it start a line of its own.
esc() { case "$1" in *[!\ -~]*) printf '%q' "$1" ;; *) printf '%s' "$1" ;; esac; }

# A name as one shell word with no bare space (N-S03-12): printf %q, whose $'…' form (a name with a
# byte outside printable ASCII) leaves a space bare, so there a space is written \040.
qw() { local q; q=$(printf '%q' "$1"); case "$q" in "\$'"*) q=${q// /\\040} ;; esac; printf '%s' "$q"; }

# ── run mode ─────────────────────────────────────────────────────────────────
if [ "${1-}" = --run ]; then
  [ "$#" -eq 6 ] || exit 2
  # A git location in the hub's own env would bind the checks to another repo.
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES \
    GIT_COMMON_DIR GIT_NAMESPACE GIT_CONFIG_COUNT GIT_DIFF_OPTS GIT_EXTERNAL_DIFF
  # N-S03-27: hub-env-only names, unset as defence in depth: a protocol list over protocol.*.allow, an
  # exec path for git's helper programs, a global config file in place of HOME's, a template dir.
  unset GIT_ALLOW_PROTOCOL GIT_EXEC_PATH GIT_CONFIG_GLOBAL GIT_TEMPLATE_DIR
  D=$2 TREE=$3 BASE=$4 SHA=$5 SUITES=$6
  cd -- "$D" || exit 2
  echo $$ > out/pid.tmp && mv out/pid.tmp out/pid || exit 2

  # Harness names (Q1, C3-3): the machine-wide sets, before and after.
  # Each dir name is written by qw as it is listed, so a name holding a newline or a space stays one
  # entry of the space-separated harness-new list.
  harness_dirs() {
    local p
    for p in /private/tmp/omt-wo021-* /private/tmp/omt-claude-plugin-*; do
      [ -e "$p" ] || [ -L "$p" ] || continue
      qw "$p"
      echo
    done | sort
  }
  harness_servers() { pgrep -f -- '^[^ ]*tmux( [^ ]+)* -L omtv-test-' | sort; }
  DIRS_BEFORE=$(harness_dirs)
  SERVERS_BEFORE=$(harness_servers)

  RESULT=2
  PART2='rerun.sh: the run ended before a result'

  # The entries in $2 (after) that are not in $1 (before), space-separated, or (none). Each is one
  # line already escaped: a %q dir name, or a pid from pgrep.
  new_names() {
    local x='' n
    while IFS= read -r n; do
      x+="$n "
    done < <(comm -13 <(printf '%s\n' "$1" | sed '/^$/d') <(printf '%s\n' "$2" | sed '/^$/d'))
    x=${x% }
    [ -n "$x" ] && printf '%s' "$x" || printf '(none)'
  }

  # §2.5 part 1: bun's summary-block lines of <file>, each with its line number (defined before the
  # first log write, since finish copies with it on every exit path).
  blk() { grep -anE '^$|^ *[0-9]+ (pass|fail|skip|todo|errors?|expect\(\) calls|filtered out)$|^snapshots: |^ *[0-9]+ snapshots, [0-9]+ expect\(\) calls$|^Ran [0-9]+ tests? across [0-9]+ files?\.' "$1" | LC_ALL=C tr -d '\000' | awk -F: '{ n = $1 + 0; t = substr($0, length($1) + 2) } t == "" { e = n; k = 0; p = 0; next } t ~ /^Ran / { if (n == p + 1 && s) for (i = 1; i <= k; i++) print b[i]; k = 0; p = 0; next } { if (n != p + 1) { k = 0; s = (n == e + 1) } b[++k] = $0; p = n }'; r=${PIPESTATUS[0]}; [ "$r" -lt 2 ] || echo "0:copy: FAILED grep rc=$r"; }

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
    # §2.5 part 1: the log.txt lines X matches and the count lines of bun's blocks, in log order.
    X='^== |^rc=-?[0-9]+$|^unhandled=[0-9]+$|^\(fail\) |^Ran [0-9]+ tests? across [0-9]+ files?\.|error TS[0-9]+:|^staged: \(empty\)$|^remotes: |^nm-source: |^channel warm-up: rc=|^tcache-entries: |^path-order: '
    [ ! -e "$D/out/log.txt" ] || { { grep -anE "$X" "$D/out/log.txt"; r=$?; [ "$r" -lt 2 ] || echo "0:copy: FAILED grep rc=$r"; blk "$D/out/log.txt" | grep -aE '^0:copy: |^[0-9]+: *[0-9]+ (pass|fail|skip|todo|errors?)$'; } | LC_ALL=C sort -t: -k1,1n -s | LC_ALL=C cut -d: -f2- >> "$D/out/summary.txt"; p=("${PIPESTATUS[@]}"); [ "${p[1]}" = 0 ] || echo "copy: FAILED sort rc=${p[1]}" >> "$D/out/summary.txt"; [ "${p[2]}" = 0 ] || echo "copy: FAILED cut rc=${p[2]}" >> "$D/out/summary.txt"; }
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
  # The checked lines are kept here and §2.4 step 8 runs these, never a second read of the file.
  n=0 SUITE_LINES=()
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    case "$line" in *$'\r'*) refuse_run 2 "R5: CR in line $n" ;; esac
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    if [ "$line" = 'channel bun test --isolate' ] || [ "$line" = 'channel tsc' ]; then
      SUITE_LINES+=("$line")
      continue
    fi
    if [[ "$line" =~ ^bun\ test(\ test/[A-Za-z0-9._/-]*)+$ ]] && [[ "$line" != *..* ]]; then
      SUITE_LINES+=("$line")
      continue
    fi
    refuse_run 2 "R5: bad line $n"
  done < "$SUITES"
  [ "${#SUITE_LINES[@]}" -ge 1 ] || refuse_run 2 'R5: no suite'

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
  # N-S03-13: a clone of <common> takes <common>/.git first, a repo none of these checks read.
  # N-S03-16: commondir sends git to another repo, and alternates lend objects from one; both are
  # refused, so the clone reads only <common>'s own objects.
  for cn in .git commondir objects/info/alternates objects/info/http-alternates; do
    [ ! -e "$common/$cn" ] && [ ! -L "$common/$cn" ] || refuse_run 6 "R6: common dir holds $cn"
  done
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
  # N-S03-21: the tree's own config.worktree, by its path and only when it exists (git reads it only
  # under extensions.worktreeconfig; reading it whenever it exists is the stricter form). An absent
  # file holds no keys; a git failure on a present one is a refusal. N-S03-22: as with info/attributes,
  # git's read blocks on a FIFO, so a present one must be a regular file; unlike info/attributes, a
  # link to a regular file passes.
  : > "$D/tmp/wtconfig"
  # The plain --git-path form: --path-format=absolute resolves a final link, so a dangling one would
  # read as absent. A relative answer is relative to the tree, where tg runs.
  tg "$D/tmp/wtpath" rev-parse --git-path config.worktree || refuse_run 6 'R6: rev-parse --git-path failed'
  wtc=$(cat "$D/tmp/wtpath")
  case "$wtc" in /*) ;; *) wtc=$TREE/$wtc ;; esac
  if [ -e "$wtc" ] || [ -L "$wtc" ]; then
    [ -f "$wtc" ] || refuse_run 6 'R6: tree config.worktree is not a regular file'
    tg "$D/tmp/wtconfig" config --list --file "$wtc" -z || refuse_run 6 'R6: tree config.worktree unreadable'
  fi
  # N-S03-20: upload-pack, run on the common dir, reads the main worktree's config.worktree; it is
  # held to the same list whenever it exists (git reads it only under the extension).
  : > "$D/tmp/mainwtconfig"
  if [ -e "$common/config.worktree" ] || [ -L "$common/config.worktree" ]; then
    [ -f "$common/config.worktree" ] || refuse_run 6 'R6: config.worktree is not a regular file'
    tg "$D/tmp/mainwtconfig" config --list --file "$common/config.worktree" -z \
      || refuse_run 6 'R6: config.worktree unreadable'
  fi
  for f in config wtconfig mainwtconfig; do
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
  # M (unmerged) is refused here too. N-S03-15: skip-worktree (S) alone is accepted on a never-staged
  # path whose index entry is HEAD's (same mode and blob, stage 0), so it hides nothing the patch or
  # w could carry (the lab's own .mcp.json move-aside, #45); each is logged in §2.4 step 6.
  same_as_head() { # <path>: its index entry equals its HEAD entry
    local rec i='' h=''
    while IFS= read -r -d '' rec; do
      [ "${rec#*$'\t'}" = "$1" ] && { i=${rec%%$'\t'*}; break; }
    done < "$D/tmp/index"
    while IFS= read -r -d '' rec; do
      [ "${rec#*$'\t'}" = "$1" ] && { h=${rec%%$'\t'*}; break; }
    done < "$D/tmp/headtree"
    [ -n "$i" ] && [ -n "$h" ] && [ "$i" = "${h%% *} ${h##* } 0" ]
  }
  SKIP_WORKTREE=''
  tg "$D/tmp/flags" ls-files -v -z || refuse_run 6 'R6: ls-files -v failed'
  while IFS= read -r -d '' rec; do
    case "$rec" in
      'H '*) ;;
      'S '*) never_staged "${rec#S }" && same_as_head "${rec#S }" && SKIP_WORKTREE+="skip-worktree: $(qw "${rec#S }")"$'\n' \
          || refuse_run 6 "R6: index flag S $(esc "${rec#S }")" ;;
      *) refuse_run 6 "R6: index flag $(esc "${rec%% *}") $(esc "${rec#* }")" ;;
    esac
  done < "$D/tmp/flags"
  # Each list goes to a file first, so a git that fails is a refusal, never an empty list.
  tg "$D/tmp/r6-unstaged" diff --name-only -z --no-ext-diff --no-textconv --ignore-submodules=all \
    || refuse_run 6 'R6: diff --name-only failed'
  tg "$D/tmp/r6-untracked" ls-files --others --exclude-standard -z \
    || refuse_run 6 'R6: ls-files --others failed'
  bad=''
  # The accepted paths as §2.4 step 6 lists them (see `lst` there).
  NEVER_STAGED_CHANGES=''
  while IFS= read -r -d '' p; do
    if never_staged "$p"; then
      NEVER_STAGED_CHANGES+="  $(qw "$p")"$'\n'
    else
      bad+="R6: unstaged $(esc "$p")"$'\n'
    fi
  done < "$D/tmp/r6-unstaged"
  while IFS= read -r -d '' p; do
    never_staged "$p" || bad+="R6: untracked $(esc "$p")"$'\n'
  done < "$D/tmp/r6-untracked"
  rm -f -- "$D/tmp/head" "$D/tmp/top" "$D/tmp/common" "$D/tmp/config" "$D/tmp/wtpath" "$D/tmp/wtconfig" "$D/tmp/mainwtconfig" "$D/tmp/index" \
    "$D/tmp/headtree" "$D/tmp/flags" "$D/tmp/r6-unstaged" "$D/tmp/r6-untracked"
  rmdir -- "$D/tmp" || refuse_run 6 'R6: scratch dir not removed'
  [ -z "$bad" ] || refuse_run 6 "${bad%$'\n'}"

  # ── R3: the staged patch's sha1 ─────────────────────────────────────────────
  tg "$D/staged.patch" diff --cached --binary --no-ext-diff --no-textconv --submodule=short \
    || refuse_run 4 'SHA MISMATCH'
  got=$(shasum "$D/staged.patch" | cut -c1-40)
  [ "$got" = "$SHA" ] || refuse_run 4 'SHA MISMATCH'

  # ── §2.4 steps 1–4: the copy w, its remotes, node_modules and the bun cache ──
  # A step that fails is `APPLY FAILED: <step>` (exit 5); a missing source in steps 3 and 4 is not.
  # tw is tg on the copy (cwd is <D>), with the same prefix, so w's checkout, apply and lists convert
  # nothing either: w holds the staged patch's bytes, with no eol, ident or filter conversion of its
  # own (under text/eol attributes, R3's patch takes a stat-clean worktree file's bytes). N-S03-25: tw
  # reads no global or system config, as apply.whitespace or core.symlinks there would change w's
  # bytes; tg keeps them (R3's sha is the team's diff as git shows it to the hub).
  tw() { # <out-file> <args…>
    local out=$1
    shift
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
      GIT_CONFIG_PARAMETERS=$NOEXEC GIT_ATTR_SOURCE=$ATTR_SOURCE GIT_NO_LAZY_FETCH=1 GIT_NO_REPLACE_OBJECTS=1 /usr/bin/git -C w "$@" > "$out" &
    wait $!
  }
  mkdir -- "$D/tmp" || refuse_run 5 'APPLY FAILED: scratch dir'
  # 1. The source is R6's common dir. A local path is the file transport, so the clone alone allows
  # it. Its upload-pack child runs without the prefix (git unsets it there). R6's allowlist holds the
  # tree's config (local, and its own config.worktree read by path whenever it exists, N-S03-21)
  # and the main worktree's config.worktree, which upload-pack on the common dir reads (N-S03-20);
  # upload-pack honours packObjectsHook only from protected config. N-S03-16: --no-local, as a local
  # clone copies the object files as they are and checkout never re-hashes them, so a team could
  # rewrite a base blob. Over the transport, index-pack hashes every object it receives. N-S03-18:
  # --revision fetches BASE by its sha, whether or not a branch or tag reaches it, so w holds BASE
  # and its history only, each object named by its own bytes. A git older than 2.49 has no
  # --revision and fails the clone, which stops the run (rc 5). N-S03-23: upload-pack keeps the
  # global and system config (packObjectsHook is honoured there), so the clone alone reads neither.
  # N-S03-26: --template= makes w's .git from no template dir (a template's info/attributes would
  # apply in w).
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_PARAMETERS="$NOEXEC 'protocol.file.allow=always'" GIT_ATTR_SOURCE=$ATTR_SOURCE GIT_NO_LAZY_FETCH=1 GIT_NO_REPLACE_OBJECTS=1 \
    /usr/bin/git clone -q --no-local --no-hardlinks --no-checkout --template= --revision="$BASE" -c core.hooksPath=/dev/null "$common" "$D/w" > "$D/tmp/clone" &
  wait $! || refuse_run 5 'APPLY FAILED: clone'
  # N-S03-19: a branch named BASE's 40 hex would win over the object id, so the checkout names the
  # commit object and HEAD is checked after it (a second layer under --revision, which makes no branch).
  tw "$D/tmp/checkout" checkout -q --detach "$BASE^{commit}" || refuse_run 5 'APPLY FAILED: checkout'
  tw "$D/tmp/whead" rev-parse HEAD || refuse_run 5 'APPLY FAILED: checkout'
  [ "$(cat "$D/tmp/whead")" = "$BASE" ] || refuse_run 5 'APPLY FAILED: checkout HEAD'
  # 2. Every remote removed; the count comes from the absolute binary, never a shim.
  tw "$D/tmp/remotes" remote || refuse_run 5 'APPLY FAILED: remote'
  while IFS= read -r r; do
    tw "$D/tmp/remove" remote remove "$r" || refuse_run 5 "APPLY FAILED: remote remove $(esc "$r")"
  done < "$D/tmp/remotes"
  tw "$D/tmp/remotes-v" remote -v || refuse_run 5 'APPLY FAILED: remote -v'
  echo "remotes: $(wc -l < "$D/tmp/remotes-v" | tr -d ' ')" >> "$D/out/log.txt"
  # 3. node_modules before R4, so R4 sees the tree the suites see: the tree's own, else the main
  # checkout's (the common dir's parent).
  main=$(dirname -- "$common")
  for nm in channel/node_modules node_modules; do
    if [ -d "$treep/$nm" ]; then
      src=$treep/$nm
    elif [ -d "$main/$nm" ]; then
      src=$main/$nm
    else
      src=''
    fi
    if [ -n "$src" ]; then
      [ ! -L "$src" ] || refuse_run 5 "APPLY FAILED: nm link outside w $(esc "$src")"
      /bin/cp -cR "$src" "$D/w/$nm" &
      wait $! || refuse_run 5 "APPLY FAILED: cp $(esc "$src")"
      echo "nm-source: $(esc "$src")" >> "$D/out/log.txt"
    else
      echo 'nm-source: (none)' >> "$D/out/log.txt"
    fi
  done
  # 4. The bun cache, a copy per run (G13).
  csrc=''
  if [ -d "$HOME/.bun/install/cache" ]; then
    csrc=$(/bin/realpath -- "$HOME/.bun/install/cache") || refuse_run 5 'APPLY FAILED: bun cache dir'
    /bin/cp -cR "$HOME/.bun/install/cache" "$D/bun-cache" &
    wait $! || refuse_run 5 'APPLY FAILED: cp bun cache'
    echo 'bun-cache: copied' >> "$D/out/log.txt"
  else
    mkdir -- "$D/bun-cache" || refuse_run 5 'APPLY FAILED: bun cache dir'
    echo 'bun-cache: (none)' >> "$D/out/log.txt"
  fi
  # N-S03-8: cp -cR keeps a link as a link, so every link in the copies must resolve inside them
  # (bun's relative .bin links do); one that resolves outside, or not at all, is a refusal. N-S03-11:
  # bun's cache links into itself by absolute path, so a cache link that resolves inside the source
  # cache is rewritten to the same path in the copy, which a write through it then stays in.
  for nm in w/channel/node_modules w/node_modules bun-cache; do
    [ -d "$D/$nm" ] || continue
    case "$nm" in bun-cache) lim="$D/bun-cache" ;; *) lim="$D/w" ;; esac
    /usr/bin/find "$D/$nm" -type l -print0 > "$D/tmp/links" &
    wait $! || refuse_run 5 "APPLY FAILED: find links $nm"
    while IFS= read -r -d '' l; do
      t=$(/bin/realpath -- "$l" 2>/dev/null) || t=''
      if [ "$nm" = bun-cache ] && [ -n "$csrc" ] && [ "${t#"$csrc"/}" != "$t" ]; then
        /bin/ln -sfn -- "$D/bun-cache/${t#"$csrc"/}" "$l" || refuse_run 5 "APPLY FAILED: link rewrite $(esc "$l")"
        continue
      fi
      case "$t" in "$lim"/*) ;; *) refuse_run 5 "APPLY FAILED: nm link outside w $(esc "$l")" ;; esac
    done < "$D/tmp/links"
  done

  # ── R4: the staged patch onto w ─────────────────────────────────────────────
  if [ ! -s "$D/staged.patch" ]; then
    echo 'staged: (empty)' >> "$D/out/log.txt"
  else
    tw "$D/tmp/apply" apply --index ../staged.patch || refuse_run 5 'APPLY FAILED'
  fi

  # ── §2.4 step 6: the logged facts ───────────────────────────────────────────
  # Each listed name or line is written by lst: two spaces, then qw (no bare space), so none can match
  # X or blk in the summary copy (a staged `rc=0`, `== x`, `error TS1: x` or `a<0x01> error TS1: x`).
  lst() { printf '  %s\n' "$(qw "$1")"; }
  tw "$D/tmp/staged" diff --cached --name-only -z --no-ext-diff --no-textconv \
    || refuse_run 5 'APPLY FAILED: staged files'
  footer='Co-Authored''-By|Generated'' with'
  {
    echo 'staged files:'
    while IFS= read -r -d '' p; do lst "$p"; done < "$D/tmp/staged"
    echo 'forbidden staged paths:'
    while IFS= read -r -d '' p; do
      [[ "$p" =~ ^(\.claude/|CLAUDE\.local\.md|\.mcp\.json|\.sisyphus/) ]] && lst "$p"
    done < "$D/tmp/staged"
    echo '(none above = ok)'
    echo 'never-staged changes:'
    printf '%s' "$NEVER_STAGED_CHANGES"
    echo '(none above = ok)'
    printf '%s' "$SKIP_WORKTREE"
    # The added lines: a `+` line inside a hunk. A file's header lines (`diff `, `+++ `) come
    # before its first @@; inside a hunk every line starts with ` `, `+`, `-` or `\`.
    echo 'footer lines:'
    awk '/^diff / { h = 0 } /^@@ / { h = 1; next } h && /^\+/' "$D/staged.patch" | grep -aiE -- "$footer" \
      | while IFS= read -r l; do lst "$l"; done
    echo '(none above = ok)'
  } >> "$D/out/log.txt"
  rm -f -- "$D/tmp/clone" "$D/tmp/checkout" "$D/tmp/whead" "$D/tmp/remotes" "$D/tmp/remove" "$D/tmp/remotes-v" "$D/tmp/apply" \
    "$D/tmp/staged" "$D/tmp/links"
  rmdir -- "$D/tmp" || refuse_run 5 'APPLY FAILED: scratch dir not removed'

  # ── §2.4 step 7: the environment (G3) ───────────────────────────────────────
  S=shim-rerun
  tm=$(command -v tmux)
  case "$tm" in /*) ;; *) tm= ;; esac
  mkdir "$S" tmux home tmp tcache || refuse_run 5 'APPLY FAILED: env dirs'
  # run.sh's lines 44-131, byte-identical (RR-shim-eq): the shims, then P and the node/bun loop.
  # Kept byte-identical, its `|| exit 2` ends the run as rc 2 with the generic part-2 text.
for c in omt claude gh; do
  printf '#!/bin/sh\necho "plan-audit: %s is refused (live system)" >&2\nexit 99\n' "$c" > "$S/$c"
done
cat > "$S/curl" <<'EOF'
#!/bin/sh
for a in "$@"; do
  case "$(printf '%s' "$a" | tr 'A-Z' 'a-z')" in
    *localhost:88[0-9][0-9]*|*localhost:98[0-9][0-9]*|*127.0.0.1:88[0-9][0-9]*|*127.0.0.1:98[0-9][0-9]*|*'[::1]:88'[0-9][0-9]*|*'[::1]:98'[0-9][0-9]*|*0.0.0.0:88[0-9][0-9]*|*0.0.0.0:98[0-9][0-9]*)
      echo "plan-audit: curl to a hub port on localhost is refused (live system)" >&2; exit 99 ;;
  esac
done
exec /usr/bin/curl "$@"
EOF
printf '#!/bin/bash\nD=%s\n' "$D" > "$S/git"
cat >> "$S/git" <<'EOF'
# push is refused everywhere; where the repo (top or git dir) is outside <D>, only read verbs.
args=("$@") pre=() cds=() sub= i=0
while [ $i -lt ${#args[@]} ]; do
  case "${args[$i]}" in
    -C|-c|--git-dir|--work-tree|--namespace|--super-prefix|--config-env|--attr-source)
      pre+=("${args[$i]}" "${args[$((i+1))]}")
      [ "${args[$i]}" = -C ] && cds+=("${args[$((i+1))]}")
      i=$((i+2)) ;;
    -*) pre+=("${args[$i]}"); i=$((i+1)) ;;
    *) sub=${args[$i]}; break ;;
  esac
done
# no repo: the dir git would run in (git init, git clone)
cwd() { for c in "${cds[@]}"; do cd "$c" 2>/dev/null || return 1; done; pwd -P; }
[ "$sub" = push ] && { echo "plan-audit: git push is refused (live system)" >&2; exit 99; }
case "$sub" in
  ''|status|log|show|diff|rev-parse|ls-files|ls-tree|cat-file|grep|blame|describe|rev-list|shortlog|merge-base|for-each-ref|show-ref|version|help) ;;
  *)
    top=$(/usr/bin/git "${pre[@]}" rev-parse --show-toplevel 2>/dev/null)
    gd=$(/usr/bin/git "${pre[@]}" rev-parse --absolute-git-dir 2>/dev/null)
    [ -n "$top$gd" ] || top=$(cwd) || top=/
    for r in "${top:-$D}" "${gd:-$D}"; do
      case "$r/" in "$D"/*) ;; *) echo "plan-audit: git $sub outside $D is refused (live system; read verbs only there)" >&2; exit 99 ;; esac
    done ;;
esac
exec /usr/bin/git "$@"
EOF
printf '#!/bin/bash\nD=%s\nT=%q\n' "$D" "$tm" > "$S/tmux"
cat >> "$S/tmux" <<'EOF'
# The test harness's own servers (-L omtv-test-*, no / in it, or bare tmux in a pane of one)
# run as asked. Every other server lives in <D>/tmux, and a -S socket in a live socket dir is refused.
[ -n "$T" ] || { echo "plan-audit: run.sh found no tmux" >&2; exit 127; }
args=("$@") L= S= sock=0 i=0
while [ $i -lt ${#args[@]} ]; do
  a=${args[$i]}
  case "$a" in --|-) break ;; -?*) ;; *) break ;; esac
  k=1
  while [ $k -lt ${#a} ]; do
    c=${a:$k:1}
    case "$c" in
      c|f|L|S|T)
        v=${a:$((k+1))}
        [ -n "$v" ] || { i=$((i+1)); v=${args[$i]}; }
        case "$c" in L) L=$v ;; S) S=$v; sock=1 ;; esac
        break ;;
    esac
    k=$((k+1))
  done
  i=$((i+1))
done
if [ $sock = 0 ]; then
  case "$L" in */*) ;; omtv-test-*) exec "$T" "$@" ;; esac
  b=${TMUX%%,*}
  [ -z "$L" ] && case "${b##*/}" in omtv-test-*) exec "$T" "$@" ;; esac
fi
unset TMUX
export TMUX_TMPDIR="$D/tmux"
if [ $sock = 1 ]; then
  if [ -e "$S" ]; then r=$(/bin/realpath "$S" 2>/dev/null); else r=$(/bin/realpath "$(dirname "$S")" 2>/dev/null)/${S##*/}; fi
  case "$r" in /tmp/tmux-*|/private/tmp/tmux-*) echo "plan-audit: tmux -S $S is in a live socket dir, refused (live system)" >&2; exit 99 ;; esac
fi
exec "$T" "$@"
EOF
chmod +x "$S/omt" "$S/claude" "$S/gh" "$S/curl" "$S/git" "$S/tmux" || exit 2

P="$D/$S:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin"
for t in node bun; do
  x=$(command -v "$t") || continue
  x=$(dirname "$(/bin/realpath "$x" 2>/dev/null)")
  case "$x" in /*) ;; *) continue ;; esac
  case "$x" in "$HOME/.local/bin"|"$HOME/.omtv/bin"|"$HOME/.oh-my-team/bin"|*:*) continue ;; esac
  P="$P:$x"
done
  # /opt/homebrew/bin right after the shims, as in the operator's own PATH (S4).
  if [ -d /opt/homebrew/bin ]; then P="$D/$S:/opt/homebrew/bin:${P#"$D/$S:"}"; fi
  echo "path-order: python3=$(PATH="$P" command -v python3 || echo '(none)')" >> "$D/out/log.txt"
  CB=$(/bin/realpath "$HOME/.local/bin/claude")
  # Each suite's env line reads $USER under set -u; without one, refuse here, not as a suite's rc.
  [ -n "${USER-}" ] || refuse_run 5 'APPLY FAILED: no USER'

  # ── §2.4 step 8: each suite in the background, waited for, so a TERM ends it at once ──
  for line in "${SUITE_LINES[@]}"; do
    case "$line" in
      'channel bun test --isolate')
        echo "== channel bun test --isolate" >> "$D/out/log.txt"
        echo "channel warm-up: start" >> "$D/out/log.txt"; t0=$(date +%s)
        (cd "$D/w/channel" && env -i HOME="$D/home" USER="$USER" LOGNAME="${LOGNAME:-$USER}" LANG="${LANG:-en_US.UTF-8}" TERM=dumb TMPDIR="$D/tmp" TMUX_TMPDIR="$D/tmux" OMT_HOME="$D/NO_HUB" PATH="$P" CLAUDE_BIN="$CB" BUN_INSTALL_CACHE_DIR="$D/bun-cache" BUN_RUNTIME_TRANSPILER_CACHE_PATH="$D/tcache" bun test >"$D/out/warmup.txt" 2>&1 </dev/null) & cpid=$!
        wait "$cpid"; wrc=$?; echo "channel warm-up: rc=$wrc s=$(( $(date +%s) - t0 )) errors=$(blk "$D/out/warmup.txt" | sed -nE 's/^[0-9]+: *([0-9]+) errors?$/\1/p' | awk '{s += $1} END {print s + 0}') ran=$(grep -aE '^Ran [0-9]+ tests? across' "$D/out/warmup.txt" | awk '{n = $2} END {print n + 0}')" >> "$D/out/log.txt"
        echo "tcache-entries: $(/usr/bin/find "$D/tcache" -type f | wc -l | tr -d ' ')" >> "$D/out/log.txt"
        (cd "$D/w/channel" && env -i HOME="$D/home" USER="$USER" LOGNAME="${LOGNAME:-$USER}" LANG="${LANG:-en_US.UTF-8}" TERM=dumb TMPDIR="$D/tmp" TMUX_TMPDIR="$D/tmux" OMT_HOME="$D/NO_HUB" PATH="$P" CLAUDE_BIN="$CB" BUN_INSTALL_CACHE_DIR="$D/bun-cache" BUN_RUNTIME_TRANSPILER_CACHE_PATH="$D/tcache" bun test --isolate >>"$D/out/log.txt" 2>&1 </dev/null) & cpid=$!
        wait "$cpid"; printf '\nrc=%s\n' "$?" >> "$D/out/log.txt"
        ;;
      'channel tsc')
        echo "== channel tsc" >> "$D/out/log.txt"
        (cd "$D/w/channel" && env -i HOME="$D/home" USER="$USER" LOGNAME="${LOGNAME:-$USER}" LANG="${LANG:-en_US.UTF-8}" TERM=dumb TMPDIR="$D/tmp" TMUX_TMPDIR="$D/tmux" OMT_HOME="$D/NO_HUB" PATH="$P" CLAUDE_BIN="$CB" BUN_INSTALL_CACHE_DIR="$D/bun-cache" bunx -p typescript@5.9.2 tsc --noEmit >>"$D/out/log.txt" 2>&1 </dev/null) & cpid=$!
        wait "$cpid"; printf '\nrc=%s\n' "$?" >> "$D/out/log.txt"
        ;;
      *)
        # `bun test test/…`: R5 allowed only [A-Za-z0-9._/-] in a path, so the split is the words.
        read -r -a cmd <<< "$line"
        echo "== $line" >> "$D/out/log.txt"
        (cd "$D/w" && env -i HOME="$D/home" USER="$USER" LOGNAME="${LOGNAME:-$USER}" LANG="${LANG:-en_US.UTF-8}" TERM=dumb TMPDIR="$D/tmp" TMUX_TMPDIR="$D/tmux" OMT_HOME="$D/NO_HUB" PATH="$P" CLAUDE_BIN="$CB" BUN_INSTALL_CACHE_DIR="$D/bun-cache" "${cmd[@]}" >>"$D/out/log.txt" 2>&1 </dev/null) & cpid=$!
        wait "$cpid"; printf '\nrc=%s\n' "$?" >> "$D/out/log.txt"
        ;;
    esac
    awk -v h="== $line" '$0 == h {on = 1; n = 0; next} on && p && /^-{31}$/ {n++} {p = ($0 == "# Unhandled error between tests")} END {print "unhandled=" n+0}' "$D/out/log.txt" >> "$D/out/log.txt"
  done
  RESULT=0 PART2=''
  exit
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
