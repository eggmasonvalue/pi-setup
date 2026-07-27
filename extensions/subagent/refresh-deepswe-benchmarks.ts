#!/usr/bin/env bun
/**
 * Refresh compact DeepSWE benchmark data in models-allowlist.json.
 *
 * Usage: bun refresh-deepswe-benchmarks.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ALLOWLIST_PATH = path.join(import.meta.dirname, "models-allowlist.json");
const LEADERBOARD_URL = "https://deepswe.datacurve.ai/artifacts/v1/leaderboard-live.json";

type Level = { deepSWE?: { pass?: number; cost?: number }; [key: string]: unknown };
type Entry = { id: string; levels?: Record<string, Level>; [key: string]: unknown };

type Row = {
  model: string;
  reasoning_effort?: string;
  pass_at_1?: number;
  mean_cost_usd?: number;
};

const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const round = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(value * 1000) / 1000 : undefined;

const raw = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, "utf8")) as { allowed?: (string | Entry)[] };
const entries = (raw.allowed ?? []).map((entry) =>
  typeof entry === "string" ? ({ id: entry, levels: {} } satisfies Entry) : entry,
);

const response = await fetch(LEADERBOARD_URL);
if (!response.ok) throw new Error(`DeepSWE request failed: ${response.status} ${response.statusText}`);
const payload = (await response.json()) as { rows?: Row[] };
const rows = payload.rows ?? [];

const byModelAndLevel = new Map<string, Row>();
for (const row of rows) {
  if (!row.model || !row.reasoning_effort) continue;
  byModelAndLevel.set(`${normalize(row.model)}\0${row.reasoning_effort}`, row);
}

const warnings: string[] = [];
for (const entry of entries) {
  const levels = entry.levels ?? {};
  const modelKey = normalize(entry.id.split("/").pop() ?? entry.id);
  for (const level of Object.keys(levels)) {
    const row = byModelAndLevel.get(`${modelKey}\0${level}`);
    if (!row) {
      warnings.push(`${entry.id}/${level}: no DeepSWE result`);
      continue;
    }
    const next: Level = { ...levels[level] };
    const deepSWE: { pass?: number; cost?: number } = { ...(next.deepSWE ?? {}) };
    const pass = round(row.pass_at_1);
    const cost = round(row.mean_cost_usd);
    if (pass !== undefined) deepSWE.pass = pass;
    if (cost !== undefined) deepSWE.cost = cost;
    next.deepSWE = deepSWE;
    levels[level] = next;
  }
  entry.levels = levels;
}

raw.allowed = entries;
fs.writeFileSync(ALLOWLIST_PATH, `${JSON.stringify(raw, null, 2)}\n`);
console.log(`Updated ${entries.length} allowlisted model(s) from ${rows.length} DeepSWE row(s).`);
for (const warning of warnings) console.warn(`Warning: ${warning}`);
