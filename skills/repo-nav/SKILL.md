---
name: repo-nav
description: Navigate and investigate the user's GitHub repositories for repository-scoped and cross-repository tasks.
disable-model-invocation: true
---

# Repo navigation

Use live GitHub data and the `gh` CLI to answer the user's task. The invocation text is the task; do not perform unrelated repository inspection.

For “my repositories”, resolve the relevant account or organization from context. If the ownership boundary is unclear, ask before claiming completeness.

## Discovery

For the first pass, build a compact inventory of the relevant repositories and resolve candidates using only:

- repository topics
- repository name
- repository description
- archived status when it changes whether a repository should be considered

Treat topic matches as strongest, then use name/description matches and clearly labeled inferences. Before filtering, aggregate the topic vocabulary and usage counts across the inventory. The `gh` CLI's repository-list output may not expose topics reliably; use the GitHub API and aggregate each repository's `topics` array when necessary:

```bash
gh api --paginate \
  'user/repos?visibility=all&affiliation=owner&per_page=100' \
  --jq '.[].topics[]?' | sort | uniq -c | sort -nr
```

Do not read every README during discovery. For creating or repairing metadata, follow [metadata-maintenance.md](references/metadata-maintenance.md).

After selecting candidates, let the task determine the investigation. Use the cheapest targeted evidence first:

- For a group overview, report the matching repositories and then read only the introductions needed.
- For library consumers or impact analysis, search dependency manifests, package/import names, and relevant local checkouts before broad README or source inspection.
- For GitHub Actions, query runs for every repository in scope; inspect jobs and logs only for relevant failures.
- For repository understanding, read its README and follow documentation links only when useful.
- For coordinated changes, establish the affected set and make a per-repository plan before editing.

There is no fixed metadata → README → docs → code sequence. Skip layers that cannot answer the question. Keep results compact and support findings with paths, run details, timestamps, and GitHub links. Distinguish confirmed matches, likely matches, and repositories not checked.

Do not mutate repositories or repository metadata unless the user explicitly asks. Before a broad mutation, show the affected set and plan.
