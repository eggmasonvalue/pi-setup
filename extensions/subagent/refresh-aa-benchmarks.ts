#!/usr/bin/env bun
/** Refresh per-thinking-level Artificial Analysis data in models-allowlist.json. */

import * as fs from "node:fs";
import * as path from "node:path";

const ALLOWLIST_PATH = path.join(import.meta.dirname, "models-allowlist.json");
const AA_BASE = "https://artificialanalysis.ai/models/";

type Metrics = { intelligence?: number; coding?: number; cost?: number };
type Entry = { id: string; levels?: Record<string, Record<string, unknown>>; [key: string]: unknown };

const round = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) / 100 : undefined;
const number = (value: string | undefined) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const metric = (html: string, patterns: RegExp[]) => {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    const value = number(match?.[1]);
    if (value !== undefined) return value;
  }
  return undefined;
};

function extractMetrics(html: string, slug: string): Metrics | null {
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const indexes = [
    ...[...html.matchAll(new RegExp(`\\\\"slug\\\\":\\\\"${escaped}\\\\"`, "g"))].map((m) => m.index ?? -1),
    ...[...html.matchAll(new RegExp(`"slug":"${escaped}"`, "g"))].map((m) => m.index ?? -1),
  ].filter((i) => i >= 0);
  const windows = indexes.map((index) => html.slice(Math.max(0, index - 1000), index + 10000));
  const result: Metrics = {
    intelligence: metric(windows.join("\\n"), [
      /intelligenceIndex["\\s:]+([0-9.]+)/,
      /artificialAnalysisIntelligenceIndex["\\s:]+([0-9.]+)/,
    ]),
    coding: metric(windows.join("\\n"), [
      /codingIndex["\\s:]+([0-9.]+)/,
      /artificialAnalysisCodingIndex["\\s:]+([0-9.]+)/,
    ]),
    cost: metric(html, [
      new RegExp(`costPerIntelligenceIndexTask["\\s:]+([0-9.]+)[^}]{0,160}detailsUrl["\\s:]+/models/${escaped}`),
      new RegExp(`detailsUrl["\\s:]+/models/${escaped}[^}]{0,160}costPerIntelligenceIndexTask["\\s:]+([0-9.]+)`),
    ]),
  };
  return Object.values(result).some((value) => value !== undefined) ? result : null;
}

const config = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, "utf8")) as { allowed?: (string | Entry)[] };
const entries = (config.allowed ?? []).map((entry) =>
  typeof entry === "string" ? ({ id: entry, levels: {} } satisfies Entry) : entry,
);
const cache = new Map<string, Metrics | null>();
const warnings: string[] = [];

async function fetchMetrics(slug: string): Promise<Metrics | null> {
  if (cache.has(slug)) return cache.get(slug) ?? null;
  try {
    const response = await fetch(`${AA_BASE}${slug}`);
    if (!response.ok) return null;
    const result = extractMetrics(await response.text(), slug);
    cache.set(slug, result);
    return result;
  } catch {
    cache.set(slug, null);
    return null;
  }
}

for (const entry of entries) {
  const base = (entry.id.split("/").pop() ?? entry.id).toLowerCase().replace(/\./g, "-");
  const levels = entry.levels ?? {};
  for (const level of Object.keys(levels)) {
    const slugs = level === "max" ? [`${base}-${level}`, base] : [`${base}-${level}`];
    let metrics: Metrics | null = null;
    for (const slug of slugs) {
      metrics = await fetchMetrics(slug);
      if (metrics) break;
    }
    if (!metrics) {
      warnings.push(`${entry.id}/${level}: no Artificial Analysis page or metrics`);
      continue;
    }
    levels[level].artificialAnalysis = {
      ...(metrics.intelligence === undefined ? {} : { intelligence: round(metrics.intelligence) }),
      ...(metrics.coding === undefined ? {} : { coding: round(metrics.coding) }),
      ...(metrics.cost === undefined ? {} : { cost: round(metrics.cost) }),
    };
  }
  entry.levels = levels;
}

config.allowed = entries;
fs.writeFileSync(ALLOWLIST_PATH, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Updated ${entries.length} allowlisted model(s) from Artificial Analysis.`);
for (const warning of warnings) console.warn(`Warning: ${warning}`);
