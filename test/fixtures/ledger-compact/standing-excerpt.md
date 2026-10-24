# Standing rulings (AI.Lab)
One line per ruling that outlives an order, ending with the order and time that made it. Append-only: the hub appends after the operator's tap; a later line supersedes an earlier one by quoting it. The hub reads this file at the start of every order (spec §4.4). Created 2026-10-13 by the hub at LWO-007 plan approval from the team's draft (plan v2 §6), each line checked against the ledgers.
- No Co-Authored-By trailer and no "Generated with Claude Code" or other attribution footer on any commit, PR, issue, comment or release note (LWO-001 00:59Z; persistent via #32, PR #34, LWO-002 12:37Z).
- ~/.omtv/settings.json carries {"attribution":{"commit":"","pr":"","sessionUrl":false}}, the object form, not false (LWO-002 01:31Z; written 12:38Z).
- Fork only: push only to origin; every gh call carries -R bitcars/<repo>; upstream is reference only, never pushed or written (LWO-002 header).
- oh-my-team-vscode: stage by path only, never -A; never stage .claude/, CLAUDE.local.md, .mcp.json, .mcp.json.disabled-issue45 (spec §1.10 holds each repo's list) (LWO-001 00:39Z; LWO-002 12:36Z).
- Never write ~/.claude/settings.json, nor any other user-level settings file; no new trust entries in ~/.claude.json (LWO-001 header; a must-not in LWO-002, -003, -004, -006; trust entries LWO-007 13:20Z).
- Close an issue only on the operator's word (LWO-001 01:07Z; LWO-005 18:50Z).
- Orders that edit AI.Lab's live paths (§0a) are tier M, not S (LWO-002 01:06Z, tap dabf1b6e; spec §5.1).
- One menu per decision, through the hub's ask; a tap relayed by a team is not a tap (LWO-001 00:42Z; LWO-004 12:52Z).
- No default-yes on a timeout; one exists only if the operator names it with its N minutes (LWO-002 12:34Z; restated LWO-007 14:10Z).
- When a gate has two reviewers and one goes silent, never close the gate on the other alone: stop the silent one, keep its partial output, respawn it with a narrower brief (LWO-004 05:28Z).
