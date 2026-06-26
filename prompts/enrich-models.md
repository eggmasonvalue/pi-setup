---
description: Enrich extensions/subagent/models-allowlist.json with Artificial Analysis metrics
argument-hint: "<AA_API_KEY> [id:slug ...]"
---
Enrich `extensions/subagent/models-allowlist.json` using Artificial Analysis data.

Run:

```bash
bun extensions/subagent/enrich.ts <AA_API_KEY> [id:slug ...]
```

Examples:

```bash
# Basic run
bun extensions/subagent/enrich.ts "$AA_API_KEY"

# With explicit overrides for slug mismatches
bun extensions/subagent/enrich.ts "$AA_API_KEY" anthropic/claude-opus-4.8:claude-opus-4-8 openai/gpt-4o-mini:gpt-4o-mini
```

What `enrich.ts` does:

- Reads `extensions/subagent/models-allowlist.json`.
- For each allowed model ID, derives a default slug from the last path segment:
  - lowercases
  - replaces `.` with `-`
- Tries the AA free models API first: `https://artificialanalysis.ai/api/v2/language/models/free` (requires `x-api-key`).
- If no API slug match is found, falls back to scraping `https://artificialanalysis.ai/models/<slug>`.
- Writes (and truncates to 2 decimals) only these allowlist fields:
  - `intelligence_index`
  - `coding_index`
  - `agentic_index`
  - `cost_per_task`
  - `output_tokens_per_second`
- Prints unmatched IDs and the available AA free-tier slugs at the end.

If models remain unmatched:

1. Choose the correct slugs from the printed AA slug list.
2. Re-run with explicit `id:slug` mappings.
3. Repeat until unmatched IDs are resolved.
