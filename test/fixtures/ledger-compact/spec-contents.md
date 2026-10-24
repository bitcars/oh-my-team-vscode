## Contents and reading map

**Contents.** Every section and subsection of §0-§8 (§7 by its title only: its body is the
answer key the spec arm must not see).
- §0 Precedence
- §0a Inherited rules
- §1 Node types and their contracts
  - §1.1 Issue
  - §1.2 Scope
  - §1.3 Restatement
  - §1.4 Plan (v1, v2)
  - §1.5 Plan audit
  - §1.6 Implement
  - §1.7 Review gate
  - §1.8 Verification (team runs, hub re-runs)
  - §1.9 Live check
  - §1.10 Signoff and commit
  - §1.11 PR and merge
  - §1.12 Release (the extension, so far)
  - §1.13 Close and housekeeping
- §2 Gates
  - §2.1 Gate table (rows are not in a fixed order; see §3.5 for live-first vs commit-first)
  - §2.2 What needs an operator tap
  - §2.3 What the push ask must say
  - §2.4 What "verified" means
- §3 Edges left free: the heuristics
  - §3.1 Splitting and parallel work
  - §3.2 Whether to scope, and who
  - §3.3 Tier
  - §3.4 Spikes and extra rounds
  - §3.5 Order of gates, and the operator acting out of order
  - §3.6 Team health: silence
  - §3.7 Ruling Fix / Defer / Reject, and narrowing
  - §3.8 Challenging evidence
  - §3.9 In or out of scope
  - §3.10 Designing a live check
- §4 Protocols
  - §4.1 Message shapes (quoted from the evidence)
  - §4.2 Ask menus
  - §4.3 Ledger: minimum shape (the WO-025 form, plus the lab's live-paths line)
  - §4.4 Artifact locations (pinned)
  - §4.5 Naming
- §5 Tiering
  - §5.1 The rule
  - §5.2 Signals and examples
- §6 Portability matrix
- §7 Model-agnostic test (acceptance)
- §8 Room left: work groups

**Reading map.** At the start of every order read the glossary, these contents, §0a and §5,
then the sections the current step names below, and the section behind any line that is
unclear. A section a row names is read on its own; it does not pull in that section's row.
A step not in the table: read the spec in full.
Dev-flow names: plan v2 → §1.4; team runs and your re-run → §1.8; push tap → §2.2 and §2.3;
COMMIT_SIGNOFF → §1.10; operator merge → §1.11; CLOSED → §1.13.

| Step | Read |
|---|---|
| Order start | §4.3, `<vault>/lab/standing.md` |
| §1.1 Issue | §1.1, §3.9, §4.3, §4.5 |
| §1.2 Scope | §1.2, §3.2, §3.9, §4.2 |
| §1.3 Restatement | §1.3, §3.6, §4.1, §5 |
| §1.4 Plan (v1, v2) | §1.4, §0a, §3.4 |
| §1.5 Plan audit | §1.5, §0, §3.7, §3.9, §4.1, §4.4 |
| §1.6 Implement | §1.6, §0, §0a, §3.1, §3.6, §3.9 |
| §1.7 Review gate | §1.7, §0, §1.5, §3.7, §3.8, §3.9 |
| §1.8 Verification (team runs, hub re-runs) | §1.8, §0, §2.4, §3.8, §3.9, §4.1 |
| §1.9 Live check | §1.9, §2.2, §3.5, §3.10, §4.2, §4.4 |
| §1.10 Signoff and commit | §1.10, §0a, §1.8, §2.2, §2.3, §4.2 |
| §1.11 PR and merge | §1.11, §2.2, §3.5, §4.2 |
| §1.12 Release (the extension, so far) | §1.12, §1.10, §2.1, §2.2, §2.3, §4.1, §4.2, §4.3 |
| §1.13 Close and housekeeping | §1.13, §4.3, §4.4 |
| §2.1 Gate table (rows are not in a fixed order; see §3.5 for live-first vs commit-first) | §2.1, §0, §3.5 |
| §2.2 What needs an operator tap | §2.2, §0a, §1.2, §1.5, §1.9, §3.3, §4.2, §5, §5.2 |
| §2.3 What the push ask must say | §2.3, §2.4 |
| §2.4 What "verified" means | §2.4, §1.8, §5 |

