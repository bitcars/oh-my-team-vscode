# ledger.sh: the hub's ledger bookkeeping, no model (#69 item A, A3). Run it with bash; mode 644.
#
#   bash ledger.sh <ledger> log "<text>"     # append one Log row
#   bash ledger.sh <ledger> now <file>       # replace the Now block's lines with <file>'s lines
#   bash ledger.sh <ledger> show [N]         # Now block + last N Log rows (default 12)
#
# The ledger must be <vault>/lab/tasks/LWO-NNN-<slug>.md, vault = OMT_VAULT_ROOT or the default
# below. Refusals write nothing, print "ledger.sh: L<n>: <reason>" on stderr and exit 2 (L13 and a
# failed post-write check exit 3). No lock: the hub runs its calls one after another (SKILL §1).
# Calls node (for the State, through hooks/ledger-compact.js's stateOf) and base utilities only.

export LC_ALL=C
set -u

refuse() { # <n> <reason> [rc]
  printf 'ledger.sh: L%s: %s\n' "$1" "$2" >&2
  exit "${3:-2}"
}

# ── arguments (L11) ──────────────────────────────────────────────────────────
[ "$#" -ge 2 ] || refuse 11 usage
LEDGER=$1 VERB=$2
case "$VERB" in
  log | now) [ "$#" -eq 3 ] || refuse 11 usage ;;
  show) [ "$#" -eq 2 ] || [ "$#" -eq 3 ] || refuse 11 usage ;;
  *) refuse 11 usage ;;
esac

# ── target (L1, L2, L3) ─────────────────────────────────────────────────────
V="${OMT_VAULT_ROOT:-$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Bin4.me/omt}"
case "$V" in
  /*) ;;
  *) refuse 1 'vault root not absolute' ;;
esac
TASKS=$(/bin/realpath "$V/lab/tasks" 2>/dev/null) || refuse 1 "not in $V/lab/tasks"
NAME_RE='^LWO-[0-9]{3,}-[^/]*\.md$'

DUP_RE=' [0-9]+\.md$' # the hook skips iCloud duplicates ("LWO-001-x 2.md"), hook:285

check_place() { # <path>: rules 1 and 2 on a path (rule 2 = names the hook accepts)
  local d b
  d=$(/bin/realpath "$(dirname -- "$1")" 2>/dev/null) || refuse 1 "not in $V/lab/tasks"
  [ "$d" = "$TASKS" ] || refuse 1 "not in $V/lab/tasks"
  b=$(basename -- "$1")
  [[ "$b" =~ $NAME_RE ]] && ! [[ "$b" =~ $DUP_RE ]] || refuse 2 'name is not LWO-NNN-<slug>.md'
}

check_place "$LEDGER"
if [ -L "$LEDGER" ]; then
  R=$(/bin/realpath "$LEDGER" 2>/dev/null) || refuse 3 'no such ledger'
  check_place "$R"
else
  R=$LEDGER
fi
[ -f "$R" ] && [ -r "$R" ] && [ ! -L "$R" ] || refuse 3 'no such ledger'
R="$(/bin/realpath "$(dirname -- "$R")")/$(basename -- "$R")"

# ── shape (L4) ───────────────────────────────────────────────────────────────
# Sets NOW_LN and LOG_LN (1-based line numbers of the two headers) for the file in $1; returns 1 on
# a bad shape. The hook matches a header by trimEnd(), which also strips Unicode spaces (U+00A0 …).
# Under LC_ALL=C those are bytes outside [[:graph:]], so a line counts as a header candidate when
# only non-[:graph:] bytes follow "## Now" / "## Log"; each must occur exactly once, and the one
# found must be a plain match (ASCII white space trimmed), else L4: fail closed where the two differ.
# Any other "## " line between ## Now and ## Log is a bad shape. "## " sections after ## Log are
# allowed (RESCOPE, Close: spec §0a); the Log section runs from ## Log to the first later "## " line
# (END_LN, 0 = EOF). A NUL anywhere is a bad shape: read drops it, the hook's trimEnd() keeps it.
shape() {
  local line n=0 nows=0 logs=0 t rest bad=0
  NOW_LN=0 LOG_LN=0 END_LN=0
  has_nul "$1" && return 1
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    t=$line
    while [[ "$t" == *[[:space:]] ]]; do t=${t%[[:space:]]}; done
    if [[ "$line" == '## Now'* ]] && rest=${line#'## Now'} && ! [[ "$rest" =~ [[:graph:]] ]]; then
      nows=$((nows + 1)); NOW_LN=$n
      [ "$t" = '## Now' ] || bad=1
    elif [[ "$line" == '## Log'* ]] && rest=${line#'## Log'} && ! [[ "$rest" =~ [[:graph:]] ]]; then
      logs=$((logs + 1)); LOG_LN=$n
      [ "$t" = '## Log' ] || bad=1
    elif [[ "$line" == '## '* ]] && [ "$nows" -ge 1 ]; then
      if [ "$logs" -eq 0 ]; then bad=1; elif [ "$END_LN" -eq 0 ]; then END_LN=$n; fi
    fi
  done < "$1"
  [ "$nows" -eq 1 ] && [ "$logs" -eq 1 ] && [ "$NOW_LN" -lt "$LOG_LN" ] && [ "$bad" -eq 0 ]
}

# Byte tests (a NUL is dropped by read and by $(...), so neither may see the bytes).
ends_nl() { [ "$(tail -c 1 -- "$1" | od -An -tx1 | tr -d ' \n')" = 0a ]; }
has_nul() { [ "$(tr -d '\000' < "$1" | wc -c)" -ne "$(wc -c < "$1")" ]; }

if [ "$VERB" = show ]; then
  shape "$R" || refuse 4 'shape: ## Now / ## Log'
else
  # ── temps (write path step 1); shape read from the copy, so line numbers match the bytes ──
  OLD='' NORM='' WROTE='' VTMP=''
  trap 'rm -f -- "$OLD" "$NORM" "$WROTE" "$VTMP"' EXIT
  DIR=$(dirname -- "$R") BASE=$(basename -- "$R")
  OLD=$(mktemp "${TMPDIR:-/tmp}/ledger-sh.XXXXXX") || exit 2
  NORM=$(mktemp "${TMPDIR:-/tmp}/ledger-sh.XXXXXX") || exit 2
  WROTE=$(mktemp "${TMPDIR:-/tmp}/ledger-sh.XXXXXX") || exit 2
  cp -- "$R" "$OLD" || refuse 3 'no such ledger'
  MODE=$(stat -f %Lp -- "$R") || exit 2
  shape "$OLD" || refuse 4 'shape: ## Now / ## Log'
fi

# ── show (L10) ───────────────────────────────────────────────────────────────
if [ "$VERB" = show ]; then
  N=${3-12}
  [[ "$N" =~ ^[0-9]+$ ]] && [ "${#N}" -le 2 ] && [ "$((10#$N))" -ge 1 ] && [ "$((10#$N))" -le 99 ] ||
    refuse 10 'show N must be 1..99'
  N=$((10#$N))
  rows=() n=0
  echo '== Now'
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    if [ "$n" -gt "$NOW_LN" ] && [ "$n" -lt "$LOG_LN" ]; then
      printf '%s\n' "$line"
    elif [ "$n" -gt "$LOG_LN" ]; then
      [[ "$line" == '## '* ]] && break
      [[ "$line" == '- '* ]] && rows+=("$line")
    fi
  done < "$R"
  M=${#rows[@]}
  K=$N; [ "$K" -gt "$M" ] && K=$M
  echo "== Log (last $K of $M)"
  for ((i = M - K; i < M; i++)); do printf '%s\n' "${rows[$i]}"; done
  exit 0
fi

# ── normalise (step 2; L5, L6, L9, L7) ───────────────────────────────────────
if [ "$VERB" = log ]; then
  TEXT=$3
  case "$TEXT" in
    *$'\r'* | *$'\n'*) refuse 5 'CR or newline in text' ;;
  esac
  [ -n "$TEXT" ] || refuse 5 'empty text'
else
  F=$3
  if [ -f "$F" ] && [ -r "$F" ]; then
    has_nul "$F" && refuse 5 'NUL in now file'
    grep -q $'\r' -- "$F" && refuse 5 'CR in now file'
  fi
  [ -f "$F" ] && [ -s "$F" ] || refuse 6 empty
  cp -- "$F" "$NORM" || refuse 6 empty
  ends_nl "$NORM" || printf '\n' >> "$NORM"
  lines=0 blank=1 hdr=0
  while IFS= read -r line; do
    lines=$((lines + 1))
    [[ "$line" =~ ^[[:space:]]*$ ]] || blank=0
    [[ "$line" == '## '* ]] && hdr=1
  done < "$NORM"
  [ "$blank" -eq 0 ] || refuse 6 empty
  [ "$hdr" -eq 0 ] || refuse 9 '## line in now file'
  [ "$lines" -le 15 ] || refuse 7 'more than 15 lines'
  awk 'length($0) > 1000 { f = 1 } END { exit !f }' "$NORM" && refuse 7 'line over 1000 bytes'

  # ── the State (L14, L8) ────────────────────────────────────────────────────
  HOOK="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)/hooks/ledger-compact.js"
  NODE=$(command -v node) || refuse 14 'cannot read State: node absent'
  [ -f "$HOOK" ] || refuse 14 'cannot read State: hook absent'
  out=$("$NODE" --no-warnings --input-type=module -e '
import { pathToFileURL } from "node:url"
const m = await import(pathToFileURL(process.argv[1]).href)
let s = ""
process.stdin.setEncoding("utf8")
for await (const c of process.stdin) s += c
const r = m.stateOf(s, true)
process.stdout.write(r === null ? "none\n" : "state:" + r.value + "\n")
' "$HOOK" < "$NORM" 2>/dev/null)
  rc=$?
  [ "$rc" -eq 0 ] || refuse 14 "cannot read State: node rc $rc"
  case "$out" in
    *$'\n'*) refuse 14 'cannot read State: bad output' ;;
    none) refuse 8 'no State the hook can read' ;;
    state:?*) ;;
    *) refuse 14 'cannot read State: bad output' ;;
  esac
fi

# ── new bytes (step 3) ───────────────────────────────────────────────────────
STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if [ "$VERB" = log ]; then
  # The row goes at the end of the Log section: byte offset AT = EOF, or the start of line END_LN
  # (the first "## " line after ## Log; the line before it ends in "\n").
  SUFFIX=''
  if [ "$END_LN" -eq 0 ]; then
    AT=$(wc -c < "$OLD")
    ends_nl "$OLD" || SUFFIX=$'\n'
  else
    AT=$(head -n "$((END_LN - 1))" "$OLD" | wc -c)
  fi
  AT=$((AT + 0))
  SUFFIX+="- $STAMP $TEXT"$'\n'
  { head -c "$AT" "$OLD"; printf '%s' "$SUFFIX"; tail -c "+$((AT + 1))" "$OLD"; } > "$WROTE"
else
  { head -n "$NOW_LN" "$OLD"; cat "$NORM"; tail -n "+$LOG_LN" "$OLD"; } > "$WROTE"
fi

# ── swap (step 4) ────────────────────────────────────────────────────────────
# The vault temp is made by mktemp (O_EXCL, unguessable name) and given the ledger's mode.
swap_in() { # <source>
  VTMP=$(mktemp "$DIR/.$BASE.ledger-tmp.XXXXXX") &&
    cp -- "$1" "$VTMP" && chmod "$MODE" "$VTMP" && mv -f -- "$VTMP" "$R"
}
swap_in "$WROTE" || exit 2

# ── post-write check (step 5) ────────────────────────────────────────────────
post_ok() {
  if [ "$VERB" = log ]; then
    local n
    n=$(printf '%s' "$SUFFIX" | wc -c)
    n=$((n + 0))
    cmp -s <(head -c "$AT" "$R") <(head -c "$AT" "$OLD") || return 1
    cmp -s <(tail -c "+$((AT + 1))" "$R" | head -c "$n") <(printf '%s' "$SUFFIX") || return 1
    cmp -s <(tail -c "+$((AT + n + 1))" "$R") <(tail -c "+$((AT + 1))" "$OLD") || return 1
    return 0
  fi
  local old_now=$NOW_LN old_log=$LOG_LN
  shape "$R" || return 1
  cmp -s <(head -n "$NOW_LN" "$R") <(head -n "$old_now" "$OLD") || return 1
  cmp -s <(head -n "$((LOG_LN - 1))" "$R" | tail -n "+$((NOW_LN + 1))") "$NORM" || return 1
  [ "$((LOG_LN - NOW_LN - 1))" -le 15 ] || return 1
  cmp -s <(tail -n "+$LOG_LN" "$R") <(tail -n "+$old_log" "$OLD") || return 1
}

if ! post_ok; then
  # ── compare-and-swap restore (step 6) ──────────────────────────────────────
  if cmp -s "$R" "$WROTE"; then
    swap_in "$OLD" || refuse 13 'restore failed' 3
    echo 'ledger.sh: post-write check failed, restored' >&2
    exit 3
  fi
  refuse 13 'changed under me, not restored' 3
fi

# ── output ───────────────────────────────────────────────────────────────────
echo "stamp: $STAMP"
echo "sha1-before: $(shasum "$OLD" | cut -c1-40)"
echo "sha1-after: $(shasum "$R" | cut -c1-40)"
echo '--- before'
echo '+++ after'
/usr/bin/diff -u "$OLD" "$R" | tail -n +3
exit 0
