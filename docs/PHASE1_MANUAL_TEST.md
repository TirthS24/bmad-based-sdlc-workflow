# Phase 1 manual test

Walks the whole pipeline in a throwaway repo with no agents and no GitHub account: you play the agents by writing the artifact files, and a fake `gh` stands in for GitHub. Takes about five minutes. Nothing here touches this repo.

`REPO` below is the path of this repo.

## 1. Sandbox

```bash
REPO=/Users/tirths/YorkIE-Core/bmad-based-sdlc-workflow
SB=$(mktemp -d /tmp/wf-sandbox-XXXX) && cd $SB
git init -q -b main && git -c user.email=a@b.c -c user.name=a commit -q --allow-empty -m init
git init -q --bare $SB.remote.git && git remote add origin $SB.remote.git      # stands in for GitHub
cp -R $REPO/.agent-workflow . && rm -rf .agent-workflow/test .agent-workflow/runs
mkdir bin && printf '#!/bin/sh\necho "gh $*" >> '"$SB"'/gh.log\necho https://github.com/you/sandbox/pull/1\n' > bin/gh && chmod +x bin/gh
export PATH=$SB/bin:$PATH                                                         # fake gh
w() { node .agent-workflow/wf.mjs "$@"; }
```

## 2. Walk the pipeline

Run these one block at a time and compare with the expectation under each.

```bash
w run "Add items endpoint"
ID=$(w status | sed -n 's/^run: //p')
```
Expect: `branch: wf/<id>`, `stage: grill_spec`, and `git branch --show-current` prints the same `wf/<id>`.

```bash
printf '# Spec\n- **REQ-1** List items\n  - **success:** GET /items returns 200\n' > specs/spec-$ID/SPEC.md
w done grill_spec --result specs/spec-$ID/SPEC.md
```
Expect: `stage: gate_spec` and `gates: spec=pending approach=pending plan=pending tests=pending review=pending final=pending`.

**Agents cannot skip a gate:**
```bash
w done gate_spec                                                       # expect: "human gates use wf approve, not wf done"
echo '{"tool_name":"Write","tool_input":{"file_path":"src/a.py"}}' | w guard preToolUse; echo "exit $?"
```
Expect: exit 1, then a `deny` JSON (`stage gate_spec cannot write src/a.py`) and exit 2.

**Reject, then redo:**
```bash
w reject gate_spec --reason "add error cases"
```
Expect: `stage: grill_spec`, `attempt: 2`, `gates: spec=rejected ...`, and a `next_action` starting `Revise after gate_spec was rejected ("add error cases")`. Also `w reject gate_spec` with no reason must fail.
```bash
w done grill_spec --result specs/spec-$ID/SPEC.md
w approve gate_spec                                                    # stage: feasibility, gates: spec=approved
```

**Approach gate needs a letter:**
```bash
printf '# Approach\nVerdict: with-changes\n## Approach A\nsmall\n## Approach B\nbig\nFits in one commit.\n' > specs/spec-$ID/approach.md
w done feasibility
w approve gate_approach                                                # expect: error, needs --approach A|B|C
w approve gate_approach --approach A                                   # stage: test_plan, "approach: A"
```

**Test plan and tests (gate after each):**
```bash
printf '# Plan\nREQ-1\n- PRD-1.1 list items (e2e, automated)\n' > specs/spec-$ID/test-plan.md
w done test_plan && w approve gate_plan                                # stage: tests
node -e "const f='.agent-workflow/config.json',fs=require('fs'),c=JSON.parse(fs.readFileSync(f));c.commands.unit='echo FAILED REQ-1; exit 1';c.commands.lint='';fs.writeFileSync(f,JSON.stringify(c,null,2))"
mkdir -p tests && echo x > tests/test_items.py
w done tests && w approve gate_tests                                   # stage: implement
```

**Implementation has no gate after it:**
```bash
node -e "const f='.agent-workflow/config.json',fs=require('fs'),c=JSON.parse(fs.readFileSync(f));c.commands.unit='exit 0';fs.writeFileSync(f,JSON.stringify(c,null,2))"
mkdir -p src && echo 'ok=1' > src/items.py
w done implement                                                       # expect: stage: review (straight through, no gate)
echo '{"tool_name":"Write","tool_input":{"file_path":"tests/test_items.py"}}' | w guard preToolUse; echo "exit $?"   # frozen test: deny, exit 2
printf -- '- [low] naming\nopen: 0\n' > review.md
w done review --result review.md && w approve gate_review              # stage: verify
mkdir -p .agent-workflow/runs/$ID/evidence && echo shot > .agent-workflow/runs/$ID/evidence/s.txt
w done verify                                                          # stage: gate_final
```

**Commit, push and PR are locked until the final gate:**
```bash
echo '{"command":"git commit -m x"}' | w guard beforeShellExecution; echo "exit $?"   # deny: "blocked until the final gate is approved", exit 2
echo '{"command":"git push origin HEAD"}' | w guard beforeShellExecution; echo "exit $?"   # also exit 2
w approve gate_final                                                   # stage: pr
echo '{"command":"git commit -m x"}' | w guard beforeShellExecution; echo "exit $?"   # allow, exit 0
```

**Open the PR:**
```bash
git add -A -- specs tests src review.md .agent-workflow/config.json && git -c user.email=a@b.c -c user.name=a commit -q -m "feat: items endpoint"
w pr                    # expect: error, "write a plain-language summary of the code changes to .agent-workflow/runs/<id>/pr-summary.md first"
printf -- '- Adds GET /items, which returns every item as JSON.\n- Unknown item ids now give a 404 instead of a server error.\n' > .agent-workflow/runs/$ID/pr-summary.md
w pr --dry-run          # prints title, base, head and the body: summary, "What changed" (your text + collapsed file list), acceptance boxes, test table, risk note. Pushes nothing.
w pr                    # pushes wf/<id> to the bare remote, runs the fake gh, prints the PR URL
cat gh.log              # gh pr create --base main --head wf/<id> --title ... --body-file .../pr-body.md
git --git-dir=$SB.remote.git branch --list     # wf/<id> is there
w status                # stage: done
```

## 3. Failure cases worth trying
- Reject `gate_review` (while at that gate): the run returns to `implement`, and `implement`/`review` must both be redone.
- `w pr` before `gate_final` → `current stage is ..., not pr` / `gate_final is not approved`.
- `w pr` with nothing committed → `no commits since <sha>; commit the run files first`.
- Delete the `origin` remote, then `w pr` → `git push failed: ...`. Edit `bin/gh` to `exit 1` → `gh pr create failed: ...`. After fixing either, `w pr` again works.

## 4. Cleanup
```bash
cd / && rm -rf $SB $SB.remote.git
```

## 5. Automated checks
```bash
cd $REPO && npm test        # 96 tests, including a full spec-to-PR walk (test/pipeline.test.mjs)
```

## 6. Try it for real in Cursor (needs `gh auth login` and a GitHub `origin`)
Run `/wf-run <description>` in a project that has the workflow installed and follow `next_action`. At each gate use `/wf-approve <gate>` or `/wf-reject <gate> <reason>`. Please note anything confusing in a `next_action` message, a gate that feels redundant, or a PR body section you'd change.

## Decisions from the first round of testing
- Six gates, in this order, is right.
- The PR body has a "What changed" section: a plain-language summary written by the agent (`pr-summary.md`), required before `wf pr` will open the PR.
- Rejecting `gate_review` returns to `implement`.
