#!/bin/bash
# plan-audit launcher: starts one headless auditor (SKILL.md step 6).
# Usage: bash run.sh <D> <lens> <claude-abs-path> [model]
# Mode 644 on purpose (spec §0a): run it with bash. It is not a sandbox; see SKILL.md.

lens=$2 claude=$3 model=${4:-opus}
case "$1" in /*) ;; *) echo "run.sh: give <D> as an absolute path" >&2; exit 2 ;; esac
D=$(cd "$1" 2>/dev/null && pwd -P) || { echo "run.sh: no dir $1" >&2; exit 2; }
case "$D" in /private/tmp/?*) ;; *) echo "run.sh: $D is not under /tmp" >&2; exit 2 ;; esac
case "$D" in *[!A-Za-z0-9._/-]*) echo "run.sh: $D has characters outside [A-Za-z0-9._/-]" >&2; exit 2 ;; esac
case "$lens" in ''|*[!a-z-]*) echo "run.sh: the lens must match [a-z-]+" >&2; exit 2 ;; esac
cd "$D" || exit 2
# From here on, a refusal too leaves no earlier run's results to be read as this one's.
rm -f "rc-$lens.txt" "final-$lens.txt" "err-$lens.txt"
case "$claude" in /*) ;; *) echo "run.sh: give claude's absolute path" >&2; exit 2 ;; esac
[ -x "$claude" ] || { echo "run.sh: $claude is not executable" >&2; exit 2; }
[ -f "prompt-$lens.txt" ] || { echo "run.sh: no prompt-$lens.txt in $D" >&2; exit 2; }

# claude loads CLAUDE.md files from its cwd up to /, and /tmp is world-writable.
p=$D
while :; do
  for f in CLAUDE.md CLAUDE.local.md .claude/CLAUDE.md; do
    [ -e "$p/$f" ] && { echo "run.sh: refusing to launch, $p/$f exists" >&2; exit 3; }
  done
  [ -z "$p" ] && break
  p=${p%/*}
done

# The auditor's HOME is <D>/home, holding only a link to the login keychain (claude's
# login), so whatever resolves ~ (bin/omt --profile, ~/.omtv, ~/.claude) lands in <D>.
# Its shims come first on its PATH, in a dir rebuilt for this lens at each launch, so
# no earlier auditor wrote them and a parallel lens's launch never removes them. home/
# and tmux/ are shared by the lenses: a link there, or a keychain link to anywhere else,
# is refused, and ln without -f never removes a parallel lens's link.
S=shim-$lens K=home/Library/Keychains
for x in home home/Library tmux; do
  [ -L "$x" ] && { echo "run.sh: refusing to launch, $D/$x is a link" >&2; exit 2; }
done
rm -rf "$S" && mkdir "$S" && mkdir -p tmux home/Library || exit 2
[ "$(readlink "$K")" = "$HOME/Library/Keychains" ] || ln -sn "$HOME/Library/Keychains" "$K" 2>/dev/null
[ "$(readlink "$K")" = "$HOME/Library/Keychains" ] || { echo "run.sh: refusing to launch, $D/$K is not a link to $HOME/Library/Keychains" >&2; exit 2; }
tm=$(command -v tmux)
case "$tm" in /*) ;; *) tm= ;; esac
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

pass=()
[ -n "$ANTHROPIC_BASE_URL" ] && pass+=(ANTHROPIC_BASE_URL="$ANTHROPIC_BASE_URL")
# OMT_HOME's last part fails bin/omt's socket-name check: bin/omt without --profile exits 2
# before any call. --profile NAME sets OMT_HOME=$HOME/.NAME, a dir under <D>/home.
env -i HOME="$D/home" USER="$USER" LOGNAME="${LOGNAME:-$USER}" LANG="${LANG:-en_US.UTF-8}" TERM=dumb TMPDIR=/tmp \
  TMUX_TMPDIR="$D/tmux" OMT_HOME="$D/NO_HUB" PATH="$P" "${pass[@]}" \
  "$claude" -p --model "$model" --setting-sources "" --strict-mcp-config --tools "Bash,Read,Grep,Glob,Write" \
  --dangerously-skip-permissions --output-format text "$(cat "prompt-$lens.txt")" \
  < /dev/null > "final-$lens.txt" 2> "err-$lens.txt"
rc=$?
echo "$rc" > "rc-$lens.txt"
exit "$rc"
