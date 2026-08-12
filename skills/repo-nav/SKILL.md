---
name: repo-nav
description: Navigate and investigate the user's GitHub repositories for repository-scoped and cross-repository tasks.
disable-model-invocation: true
---

# Repo navigation

Use live GitHub data and the `gh` CLI to answer the user's task. The invocation text is the task; do not perform unrelated repository inspection.

For “my repositories”, resolve the relevant account or organization from context. If the ownership boundary is unclear, ask before claiming completeness.

For the first pass, resolve the candidate set using only:

- repository topics
- repository name
- repository description

Treat topic matches as strongest, and label name/description matches or other inferences. Do not read every README during discovery.

After selecting candidates, let the task determine the investigation. Use the cheapest targeted evidence first:

- For a group overview, report the matching repositories and then read only the introductions needed.
- For library consumers or impact analysis, search dependency manifests, package/import names, and relevant local checkouts before broad README or source inspection.
- For GitHub Actions, query runs for every repository in scope; inspect jobs and logs only for relevant failures.
- For repository understanding, read its README and follow documentation links only when useful.
- For coordinated changes, establish the affected set and make a per-repository plan before editing.

There is no fixed metadata → README → docs → code sequence. Skip layers that cannot answer the question. Keep results compact and support findings with paths, run details, timestamps, and GitHub links. Distinguish confirmed matches, likely matches, and repositories not checked.

Do not mutate repositories or repository metadata unless the user explicitly asks. Before a broad mutation, show the affected set and plan.
