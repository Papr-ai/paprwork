---
id: preloaded-github-integration
name: GitHub Integration
description: Manage GitHub repositories, create PRs, issues, and review code using the gh CLI.
---
# GitHub Integration

Manage GitHub repositories using the `gh` CLI tool (GitHub's official command-line interface).

## Prerequisites

The `gh` CLI must be installed and authenticated:

```bash
brew install gh    # macOS
gh auth login      # Authenticate
```

## Common Operations

### Repository Management
```bash
gh repo clone owner/repo          # Clone
gh repo create my-repo --public   # Create
gh repo view owner/repo           # View
gh repo list                      # List yours
```

### Pull Requests
```bash
gh pr create --title "Title" --body "Description"   # Create PR
gh pr create --fill                                  # Auto-fill from commits
gh pr list                                           # List PRs
gh pr view 123                                       # View details
gh pr review 123 --approve                           # Approve
gh pr review 123 --request-changes --body "Fix..."   # Request changes
gh pr checkout 123                                   # Checkout locally
gh pr merge 123 --squash --delete-branch             # Merge
gh pr diff 123                                       # View diff
```

### Issues
```bash
gh issue create --title "Bug: Something broke" --body "Steps..."  # Create
gh issue list                          # List
gh issue view 123                      # View
gh issue comment 123 --body "Note"     # Comment
gh issue close 123                     # Close
gh issue edit 123 --add-assignee @me   # Assign
```

### Workflows (GitHub Actions)
```bash
gh workflow list     # List workflows
gh run list          # View runs
gh run view 123      # Specific run
gh run rerun 123     # Re-run
```

### Releases
```bash
gh release create v1.0.0 --title "Version 1.0.0" --notes "Release notes"
gh release upload v1.0.0 file.zip
gh release list
```

## Best Practices

### Feature Development
```bash
git checkout -b feature/name
# ...make changes...
git commit -am "Implement feature"
git push -u origin feature/name
gh pr create --fill
# After review:
gh pr merge --squash --delete-branch
```

### Bug Fix with Issue Reference
```bash
gh issue create --title "Bug: Description" --label bug
git checkout -b fix/issue-123
# ...fix...
gh pr create --title "Fix #123: Description"
```

## Advanced Features

### Search
```bash
gh search code "function authenticate" --repo owner/repo
gh search issues "bug" --repo owner/repo --label bug
gh search prs "refactor" --repo owner/repo --state merged
```

### JSON Output for Parsing
```bash
gh pr list --json number,title,state
gh pr list --json number,title --jq '.[] | "\(.number): \(.title)"'
gh issue list --assignee @me --json number,title,state,createdAt
```

## Error Handling

```bash
gh auth status     # Check auth
gh auth login      # Re-login if needed
gh repo view owner/repo   # Verify access
```

## When to Use

Use when the user asks to:
- Create, view, or manage GitHub repositories
- Create or review pull requests
- Manage issues and bug reports
- Interact with GitHub Actions workflows
- Create releases or tags
- Search code or issues across repos
