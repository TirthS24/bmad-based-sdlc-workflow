1. Target developer experience

The final workflow should be as simple as:

/gerrit-review <branch-or-gerrit-url>

Examples:

/gerrit-review feature/PBA-123

or:

/gerrit-review https://gerrit.example.com/c/project/+/123456

And ideally, if no argument is supplied:

/gerrit-review

the command determines the current Git branch and uses that.

The developer should not need to manually provide the diff, files, Gerrit change ID, or review context.

2. High-level architecture
                         Developer
                             │
                             │
                    /gerrit-review <input>
                             │
                             ▼
              ┌──────────────────────────┐
              │ Cursor Custom Command    │
              │ gerrit-review.md         │
              └────────────┬─────────────┘
                           │
                           │ 1. Resolve Gerrit Change
                           ▼
              ┌──────────────────────────┐
              │       Gerrit MCP         │
              │                          │
              │ - resolve/search change  │
              │ - get change details     │
              │ - get changed files      │
              │ - get diffs              │
              │ - get existing comments  │
              └────────────┬─────────────┘
                           │
                           │ Review Context
                           ▼
              ┌──────────────────────────┐
              │   Code Review Subagent   │
              │                          │
              │ /code-review skill      │
              │ + Gerrit diff            │
              │ + repository context     │
              │ + project context        │
              └────────────┬─────────────┘
                           │
                           │ Structured ReviewResult
                           ▼
              ┌──────────────────────────┐
              │   Parent Agent           │
              │                          │
              │ Validate / transform     │
              │ findings                 │
              └────────────┬─────────────┘
                           │
                           ▼
              ┌──────────────────────────┐
              │       Gerrit MCP         │
              │                          │
              │ post comment             │
              │ suggested edit           │
              └──────────────────────────┘

The key architectural principle is:

The subagent should know how to review code; the command should know how to orchestrate Gerrit.

Don't put Gerrit MCP instructions inside the code-review subagent.

3. Proposed project structure

I would start with:

.cursor/
├── commands/
│   └── gerrit-review.md
│
└── agents/
    └── gerrit-code-reviewer.md

Your existing skill remains where it is:

.cursor/
└── skills/
    └── code-review/
        └── SKILL.md

So the responsibilities become:

Component	Responsibility
gerrit-review.md	Orchestration
gerrit-code-reviewer.md	AI code review
/code-review	Existing project review methodology
Gerrit MCP	Gerrit interaction
Repository	Source code/project context

Cursor project subagents live under .cursor/agents/, while project commands live under .cursor/commands/.

4. Custom Command responsibilities

The custom command should not perform the actual review itself.

It should orchestrate these steps:

1. Parse input
       ↓
2. Resolve Gerrit change
       ↓
3. Collect Gerrit context
       ↓
4. Prepare review context
       ↓
5. Delegate to code-review subagent
       ↓
6. Receive structured ReviewResult
       ↓
7. Validate ReviewResult
       ↓
8. Convert findings to Gerrit MCP operations
       ↓
9. Post comments / suggested edits
       ↓
10. Report result

This is exactly the type of workflow that benefits from a subagent because the review can be context-heavy without polluting the parent agent's context. Cursor specifically describes subagents as isolated context windows that return their results to the parent agent.

5. Step 1 — Input resolution

The command should accept:

branch name

or:

Gerrit URL

or nothing.

Case 1 — Gerrit URL
/gerrit-review https://gerrit.company.com/c/project/+/123456

Extract:

gerrit_base_url
project
change_number

Then directly retrieve the change.

Case 2 — Branch
/gerrit-review feature/PBA-123

Use Gerrit MCP to identify the corresponding open change.

Case 3 — Nothing
/gerrit-review

Run:

git branch --show-current

and use the result to resolve the Gerrit change.

Important rule

Do not make the LLM guess the Gerrit change from a branch name.

The workflow should require an actual Gerrit change resolution before proceeding.

The Gerrit MCP server is specifically designed to query changes and retrieve/change review information through Gerrit.

6. Step 2 — Build the Gerrit review context

Once the change is identified, the command should gather:

Change metadata
├── change ID
├── project
├── branch
├── author
├── patch set
└── status


Changed files
├── file A
├── file B
└── file C


Diff
├── file A diff
├── file B diff
└── file C diff


Existing comments
├── comment 1
├── comment 2
└── ...

The Gerrit MCP server exposes tools for querying changes, getting change details, retrieving changed files/diffs, and interacting with review comments.

This entire collection becomes the input to the subagent.

7. Step 3 — Delegate to the code-review subagent

This is where I would make a very deliberate separation.

The command tells the subagent:

Review this Gerrit change.

The subagent itself knows:

How to review the code.

And your existing /code-review skill tells it:

What constitutes a good review in this project.

Conceptually:

Gerrit Command
      │
      │ review context
      ▼
gerrit-code-reviewer
      │
      ├── /code-review
      │
      ├── repository
      │
      ├── changed files
      │
      └── diff
      │
      ▼
Structured ReviewResult

Cursor supports explicitly invoking a custom subagent and subagents can inherit tools available to the parent, including MCP tools.

However, I would deliberately not give the code-review subagent responsibility for posting to Gerrit.

Its output should be data.

8. Code-review subagent

The subagent should be something like:

.cursor/agents/gerrit-code-reviewer.md

Its responsibility:

Input:
    Gerrit change context


Process:
    Load /code-review
    Understand change
    Inspect repository
    Review diff
    Validate findings


Output:
    Structured ReviewResult

Importantly, your requirement says:

The subagent has all the instructions what to perform in a code review with project context.

So don't duplicate those instructions inside the command.

The subagent should simply establish:

You are the code-review specialist.


Use the project's /code-review skill as the authoritative
review methodology.


Review the supplied Gerrit change and return ONLY the
structured ReviewResult defined below.


Do not post comments.
Do not modify files.
Do not perform Gerrit operations.

This keeps the subagent clean.

9. Structured output is the most important design decision

You need a contract between:

Code Review Subagent
             ↓
       Gerrit MCP

I recommend defining a ReviewResult.

For example:

{
  "summary": {
    "overall": "changes_require_attention",
    "files_reviewed": 8,
    "findings_count": 3
  },
  "findings": [
    {
      "id": "CR-001",
      "severity": "HIGH",
      "category": "correctness",
      "file": "src/payment/service.py",
      "line": 142,
      "title": "Potential duplicate payment creation",
      "comment": "The retry path creates a new PaymentIntent without checking whether an existing payment is already processing.",
      "suggested_fix": {
        "type": "gerrit_suggestion",
        "replacement": "..."
      },
      "confidence": 0.96
    }
  ]
}

The exact schema can be refined later.

The important point is:

Don't make the parent agent parse natural-language review output.

Avoid:

"The reviewer found three things..."

Instead:

ReviewResult
    ↓
findings[]
    ↓
Gerrit operations
10. Separate comments from suggested edits

Your structured result should distinguish:

Comment
{
  "type": "comment",
  "file": "src/foo.py",
  "line": 42,
  "body": "This can result in..."
}
Suggested edit
{
  "type": "suggestion",
  "file": "src/foo.py",
  "line_start": 42,
  "line_end": 44,
  "body": "..."
}

This distinction matters because:

Finding
   │
   ├── comment only
   │
   └── suggested edit

A finding doesn't necessarily require an edit.

11. Suggested edits should be conservative

I would put a strict rule into the subagent:

Only generate a suggested edit when the correction is unambiguous and can be represented as a localized code replacement.

For example:

Bad:


"Consider restructuring this entire service."



Not a suggested edit.

Whereas:

Replace:


if payment.status == "processing":
    create_payment()


With:


if payment.status != "processing":
    create_payment()

is suitable for a Gerrit suggestion.

This prevents the automation from attempting large or speculative changes through review suggestions.

12. Parent agent validates the subagent output

After the subagent returns:

ReviewResult

the parent agent should not blindly send every finding to Gerrit.

Perform a lightweight validation:

For every finding:


✓ file exists
✓ line belongs to changed code
✓ finding is actionable
✓ no duplicate
✓ severity is valid
✓ comment is non-empty
✓ suggested edit is syntactically meaningful

Especially:

A review comment should normally point to code changed by the Gerrit patch.

This protects against the AI reviewing some unrelated pre-existing problem and posting it to the change.

13. Gerrit MCP becomes the execution layer

After validation:

ReviewResult
     │
     ├── comment finding
     │       ↓
     │   Gerrit MCP
     │
     └── suggestion finding
             ↓
         Gerrit MCP

The Gerrit MCP repository documents itself as an MCP server for interacting with Gerrit changes and managing reviews.

The command should therefore contain the mapping:

ReviewResult.findings[]
        │
        ├── type=comment
        │       ↓
        │   post Gerrit comment
        │
        └── type=suggestion
                ↓
            Gerrit suggested edit

The exact MCP tool names should be based on the tools exposed by your configured Gerrit MCP version, rather than hard-coded into the review subagent.

That's another reason to keep MCP logic out of the subagent.

14. Recommended execution mode

For the first version:

/gerrit-review <branch>

should:

Resolve change
     ↓
Review
     ↓
Show findings
     ↓
Ask for confirmation
     ↓
Post to Gerrit

For example:

Code review completed.


Found 4 actionable findings:


HIGH
  CR-001 src/payment/service.py:142
  Potential duplicate PaymentIntent creation


MEDIUM
  CR-002 src/invoice/repository.py:81
  Query executes once for every invoice


LOW
  CR-003 ...


LOW
  CR-004 ...


2 findings contain suggested edits.


Would you like me to publish these findings to Gerrit?

Then:

Yes

causes the MCP operations.

15. Don't automatically edit the local repository

For this workflow, I would explicitly prohibit the review subagent from using edit tools.

The desired flow is:

Gerrit Change
      ↓
Review
      ↓
Comment / Suggestion
      ↓
Gerrit

not:

Gerrit Change
      ↓
Review
      ↓
Modify local source
      ↓
Commit

This keeps the reviewer workflow completely non-destructive.

16. Phase 1 implementation plan

I would implement this in four small stages.

Phase 1 — Command skeleton

Create:

.cursor/commands/gerrit-review.md

Implement:

/gerrit-review <branch-or-url>

with:

input detection
branch detection
Gerrit change resolution
change metadata retrieval
changed-file retrieval
diff retrieval

No AI review yet.

Phase 2 — Review subagent

Create:

.cursor/agents/gerrit-code-reviewer.md

Implement:

Gerrit context
      ↓
gerrit-code-reviewer
      ↓
/code-review
      ↓
ReviewResult

At this stage, simply print the structured result.

This lets you validate whether your existing /code-review skill produces useful findings before involving Gerrit writes.

Phase 3 — Gerrit integration

Implement:

ReviewResult
      ↓
validate
      ↓
Gerrit MCP
      ↓
comments

Then add:

suggested edit

support.

Phase 4 — Approval/automation

Finally:

/gerrit-review branch

→ confirmation before publishing.

Later, optionally:

/gerrit-review branch --auto-publish

→ publish automatically.

I would not implement --auto-publish initially.

17. Final component responsibilities

The resulting system should have this very clean division:

Component	Does	Does not do
/gerrit-review	Orchestration	Actual code-review reasoning
gerrit-code-reviewer	Performs review	Gerrit mutations
/code-review	Defines review methodology	Gerrit interaction
Gerrit MCP	Reads/writes Gerrit	Decide whether code is good
Repository	Provides implementation context	Review orchestration

So the final mental model is:

             ┌──────────────────────┐
             │ /gerrit-review       │
             │ COMMAND              │
             │                      │
             │ "Coordinate this"    │
             └──────────┬───────────┘
                        │
                        ▼
             ┌──────────────────────┐
             │ Gerrit MCP           │
             │                      │
             │ "Get the change"     │
             └──────────┬───────────┘
                        │
                        ▼
             ┌──────────────────────┐
             │ gerrit-code-reviewer │
             │ SUBAGENT             │
             │                      │
             │ "Review the code"    │
             └──────────┬───────────┘
                        │
                        ▼
             ┌──────────────────────┐
             │ /code-review         │
             │ SKILL                │
             │                      │
             │ "How to review"      │
             └──────────┬───────────┘
                        │
                        ▼
                 ReviewResult
                        │
                        ▼
             ┌──────────────────────┐
             │ /gerrit-review       │
             │ COMMAND              │
             │                      │
             │ Validate + transform │
             └──────────┬───────────┘
                        │
                        ▼
             ┌──────────────────────┐
             │ Gerrit MCP           │
             │                      │
             │ Comment / Suggest    │
             └──────────────────────┘
The key design choice

I would not create a second review skill on top of /code-review yet.

Your requirement that "for now, only use code-review skills; we'll add further instructions later" is a good constraint. Keep the first implementation deliberately thin:

Command = orchestration → Subagent = /code-review → Structured output → Gerrit MCP.

Cursor's current architecture explicitly supports this composition of Commands, Skills, Subagents, and MCPs