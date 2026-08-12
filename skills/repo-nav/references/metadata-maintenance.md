# Repository metadata maintenance

Use this guide when creating or repairing GitHub metadata for repositories in the
user's navigation inventory. This is a routing aid for agents, not GitHub
marketing copy.

## Policy

Use a **dense description and thin topics**:

- Write one coherent routing abstract, normally 180–255 characters.
- State what the repository is, its domain, its main purpose, and a useful
  boundary or distinction.
- Use 1–3 topics per repository.
- Prefer existing vocabulary over inventing synonyms.
- Use topics for coarse retrieval facets, not every feature or implementation
  detail.
- Do not add language, framework, integration, or lifecycle topics merely
  because they appear in the repository.
- Do not repeat the description mechanically in the topics.

Mention status in the description only when it changes agent routing. Useful
examples include `abandoned`, `reference archive`, `data-only`, and `personal
miscellaneous dump`. Do not mention routine states such as active, in use,
early development, or experimental unless the user specifically wants that
information exposed.

GitHub's native archived flag is authoritative for archival state. Do not use
`abandoned` as a topic.

## New-repository workflow

1. Confirm the ownership boundary and canonical `OWNER/REPO`.
2. Fetch the repository's current description, topics, visibility, fork state,
   and archived state.
3. Inspect only the cheapest local evidence needed: the README introduction,
   top-level structure, and relevant manifest or context file.
4. Aggregate the account's existing topic vocabulary and usage counts before
   choosing new topics.
5. Write a description that can rule the repository in or out without opening
   the README.
6. Choose no more than three high-value topics, reusing established terms where
   possible.
7. Show the proposed before/after metadata and confidence before mutating it.
8. Apply only after explicit user approval, then re-fetch and verify the exact
   description and topic set.

For a first-pass topic index, the REST API is more reliable than assuming that
all `gh repo list --json` fields expose topics:

```bash
gh api --paginate \
  'user/repos?visibility=all&affiliation=owner&per_page=100' \
  --jq '.[].topics[]?' | sort | uniq -c | sort -nr
```

For an organization, use its repository endpoint instead:

```bash
gh api --paginate \
  'orgs/ORG/repos?type=all&per_page=100' \
  --jq '.[].topics[]?' | sort | uniq -c | sort -nr
```

