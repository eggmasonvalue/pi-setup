#!/usr/bin/env bun
/**
 * Fetches AA free-tier model data and enriches models-allowlist.json.
 * Falls back to AA model pages when free-tier slugs are stale/missing.
 * Prints unmatched IDs with the full AA slug list for manual resolution.
 *
 * Usage: bun enrich.ts <api-key> [id:slug ...]
 *   id:slug  Explicit mappings for unmatched entries
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ALLOWLIST_PATH = path.join(import.meta.dirname, "models-allowlist.json");

const [apiKey, ...mappingArgs] = process.argv.slice(2);

if (!apiKey) {
  console.error("Usage: bun enrich.ts <api-key> [id:slug ...]");
  process.exit(1);
}

const manualMap = new Map(mappingArgs.map((m) => m.split(":") as [string, string]));

const truncate2 = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? Math.trunc(value * 100) / 100 : null;

const parseNumber = (value: string | undefined) => {
  if (!value || value === "null") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const pickMetric = (source: string, patterns: RegExp[]) => {
  for (const pattern of patterns) {
    const match = source.match(pattern);
    const parsed = parseNumber(match?.[1]);
    if (parsed !== null) return parsed;
  }
  return null;
};

const extractLdJsonMetrics = (html: string, slug: string) => {
  const detailsUrl = `/models/${slug}`;
  const scripts = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs)]
    .map((m) => m[1]);

  let intelligence: number | null = null;
  let costPerTask: number | null = null;
  let outputTps: number | null = null;

  for (const script of scripts) {
    try {
      const obj = JSON.parse(script);
      if (!Array.isArray(obj?.data)) continue;
      const row = obj.data.find((r: any) => r?.detailsUrl === detailsUrl);
      if (!row) continue;

      if (typeof row.artificialAnalysisIntelligenceIndex === "number") {
        intelligence = row.artificialAnalysisIntelligenceIndex;
      }
      if (typeof row.intelligenceIndex === "number" && intelligence === null) {
        intelligence = row.intelligenceIndex;
      }
      if (typeof row.costPerIntelligenceIndexTask === "number") {
        costPerTask = row.costPerIntelligenceIndexTask;
      }
      if (typeof row.outputSpeed === "number") {
        outputTps = row.outputSpeed;
      }
      if (typeof row.medianOutputSpeed === "number" && outputTps === null) {
        outputTps = row.medianOutputSpeed;
      }
    } catch {
      // ignore invalid ld+json blocks
    }
  }

  return { intelligence, costPerTask, outputTps };
};

const extractPayloadMetrics = (html: string, slug: string) => {
  const escapedSlug = `\\"slug\\":\\"${slug}\\"`;
  const plainSlug = `"slug":"${slug}"`;

  const patterns = {
    intelligence: [
      /\\"intelligence_index\\":([0-9.]+|null)/,
      /"intelligence_index":([0-9.]+|null)/,
      /\\"artificial_analysis_intelligence_index\\":([0-9.]+|null)/,
      /"artificial_analysis_intelligence_index":([0-9.]+|null)/,
    ],
    coding: [
      /\\"coding_index\\":([0-9.]+|null)/,
      /"coding_index":([0-9.]+|null)/,
    ],
    agentic: [
      /\\"agentic_index\\":([0-9.]+|null)/,
      /"agentic_index":([0-9.]+|null)/,
      /\\"artificial_analysis_agentic_index\\":([0-9.]+|null)/,
      /"artificial_analysis_agentic_index":([0-9.]+|null)/,
    ],
  };

  const idxs = [
    ...[...html.matchAll(new RegExp(escapedSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))].map((m) => m.index ?? -1),
    ...[...html.matchAll(new RegExp(plainSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))].map((m) => m.index ?? -1),
  ].filter((i) => i >= 0);

  if (!idxs.length) return { intelligence: null, coding: null, agentic: null };

  let best = { intelligence: null as number | null, coding: null as number | null, agentic: null as number | null };
  let bestScore = -1;

  for (const idx of idxs) {
    const window = html.slice(Math.max(0, idx - 120000), Math.min(html.length, idx + 120000));
    const candidate = {
      intelligence: pickMetric(window, patterns.intelligence),
      coding: pickMetric(window, patterns.coding),
      agentic: pickMetric(window, patterns.agentic),
    };
    const score = [candidate.intelligence, candidate.coding, candidate.agentic].filter((v) => v !== null).length;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
};

const siteCache = new Map<string, {
  intelligence_index: number | null;
  coding_index: number | null;
  agentic_index: number | null;
  cost_per_task: number | null;
  output_tokens_per_second: number | null;
} | null>();

const fetchSiteMetrics = async (slug: string) => {
  if (siteCache.has(slug)) return siteCache.get(slug)!;

  try {
    const res = await fetch(`https://artificialanalysis.ai/models/${slug}`);
    if (!res.ok) {
      siteCache.set(slug, null);
      return null;
    }

    const html = await res.text();
    const ld = extractLdJsonMetrics(html, slug);
    const payload = extractPayloadMetrics(html, slug);

    const metrics = {
      intelligence_index: truncate2(payload.intelligence ?? ld.intelligence),
      coding_index: truncate2(payload.coding),
      agentic_index: truncate2(payload.agentic),
      cost_per_task: truncate2(ld.costPerTask),
      output_tokens_per_second: truncate2(ld.outputTps),
    };

    // treat as unusable if every field is null
    if (Object.values(metrics).every((v) => v === null)) {
      siteCache.set(slug, null);
      return null;
    }

    siteCache.set(slug, metrics);
    return metrics;
  } catch {
    siteCache.set(slug, null);
    return null;
  }
};

const res = await fetch("https://artificialanalysis.ai/api/v2/language/models/free", {
  headers: { "x-api-key": apiKey },
});
if (!res.ok) throw new Error(`AA API ${res.status}: ${await res.text()}`);
const { data: aaModels } = await res.json();

const config = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, "utf-8"));
const unmatched: string[] = [];

config.allowed = await Promise.all(
  config.allowed.map(async (entry: string | { id: string }) => {
    const id = typeof entry === "string" ? entry : entry.id;
    const slug =
      manualMap.get(id) ??
      id
        .split("/")
        .pop()!
        .toLowerCase()
        .replace(/\./g, "-");

    const match = aaModels.find((m: { slug: string }) => m.slug === slug);
    if (match) {
      return {
        id,
        intelligence_index: truncate2(match.evaluations.artificial_analysis_intelligence_index),
        coding_index: truncate2(match.evaluations.artificial_analysis_coding_index),
        agentic_index: truncate2(match.evaluations.artificial_analysis_agentic_index),
        cost_per_task: truncate2(match.artificial_analysis_intelligence_index_cost?.cost_per_task?.total_cost),
        output_tokens_per_second: truncate2(match.performance?.median_output_tokens_per_second),
      };
    }

    const siteMetrics = await fetchSiteMetrics(slug);
    if (siteMetrics) {
      return {
        id,
        ...siteMetrics,
      };
    }

    unmatched.push(id);
    return entry;
  })
);

fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify(config, null, 2) + "\n");
console.log("Written.");

if (unmatched.length) {
  console.log("\nUnmatched IDs:", unmatched);
  console.log("\nAvailable AA slugs:");
  for (const m of aaModels) console.log(`  ${m.slug}  "${m.name}"`);
}
