# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `Robotwizardt/aivsai`.
Use the `gh` CLI for all operations.

## Repository targeting

Always explicitly target `Robotwizardt/aivsai` using
`--repo Robotwizardt/aivsai`, including before local Git is initialized.
For `gh api`, include `repos/Robotwizardt/aivsai/` in repository endpoints.

If a future Git remote points to a different repository, ask the user
which target is correct before publishing or modifying issues.

## Conventions

- Create: `gh issue create --repo Robotwizardt/aivsai --title "..." --body "..."`
- Read: `gh issue view <number> --repo Robotwizardt/aivsai --comments`
- List: `gh issue list --repo Robotwizardt/aivsai --state open --json number,title,body,labels`
- Comment: `gh issue comment <number> --repo Robotwizardt/aivsai --body "..."`
- Add labels: `gh issue edit <number> --repo Robotwizardt/aivsai --add-label "..."`
- Remove labels: `gh issue edit <number> --repo Robotwizardt/aivsai --remove-label "..."`
- Close: `gh issue close <number> --repo Robotwizardt/aivsai --comment "..."`

Use a heredoc for multiline bodies.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub shares numbering between issues and pull requests.
When a reference is ambiguous, check whether it is a pull request
before treating it as an issue.

## When a skill says "publish to the issue tracker"

Create a GitHub issue in `Robotwizardt/aivsai`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --repo Robotwizardt/aivsai --comments`.

## Wayfinding operations

Used by `/wayfinder` if installed.

- Map: one issue labelled `wayfinder:map`, containing Notes,
  Decisions-so-far, and Fog.
- Child tickets: link them as GitHub sub-issues. If unavailable,
  use a task list in the map and `Part of #<map>` in each child.
  Use `wayfinder:<type>` labels for research, prototype, grilling,
  or task.
- Blocking: prefer native GitHub issue dependencies. API dependency
  writes use the blocker's numeric database ID, not its issue number
  or node ID. If unavailable, use `Blocked by: #<n>, #<n>` in the
  child body. A ticket is unblocked when every blocker is closed.
- Frontier: select open, unblocked, unassigned children in map order.
- Claim: assign the selected ticket to the driving developer before work.
- Resolve: comment with the answer, close the ticket, then append
  a summary and link to the map's Decisions-so-far.
