import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type TruncationResult,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { mkdtemp, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
  published_date?: string;
}

interface TavilyExtractResult {
  url?: string;
  raw_content?: string;
  images?: string[];
}

interface TavilyFailedExtractResult {
  url?: string;
  error?: string;
}

interface ExtractWebDetails {
  urls: string[];
  query?: string;
  extractDepth: "basic" | "advanced";
  format: "markdown" | "text";
  chunksPerSource?: number;
  elapsedMs: number;
  resultCount: number;
  failedResults: TavilyFailedExtractResult[];
  truncation?: TruncationResult;
  fullOutputPath?: string;
  results: TavilyExtractResult[];
  insecureTlsFallbackUsed?: boolean;
  warning?: string;
}

interface SearchWebDetails {
  query: string;
  maxResults: number;
  depth: "basic" | "advanced";
  topic?: "general" | "news";
  includeDomains?: string[];
  excludeDomains?: string[];
  includeRawContent: boolean;
  elapsedMs: number;
  resultCount: number;
  truncation?: TruncationResult;
  fullOutputPath?: string;
  results: TavilyResult[];
  insecureTlsFallbackUsed?: boolean;
  warning?: string;
}

interface HttpJsonResponse {
  status: number;
  statusText: string;
  bodyText: string;
}

function buildErrorMessage(err: unknown): string {
  const e = err as any;
  const code = e?.code ? ` [${e.code}]` : "";
  const causeMessage = e?.cause?.message ? ` | cause: ${e.cause.message}` : "";
  const causeCode = e?.cause?.code ? ` [${e.cause.code}]` : "";
  return `${e?.message ?? String(err)}${code}${causeMessage}${causeCode}`;
}

function isTlsCertError(err: unknown): boolean {
  const e = err as any;
  const text = `${e?.message ?? ""} ${e?.cause?.message ?? ""}`.toLowerCase();
  const code = `${e?.code ?? ""}`.toUpperCase();
  const causeCode = `${e?.cause?.code ?? ""}`.toUpperCase();

  return (
    code.includes("CERT") ||
    causeCode.includes("CERT") ||
    causeCode === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" ||
    text.includes("unable to get local issuer certificate") ||
    text.includes("self signed certificate") ||
    text.includes("certificate")
  );
}

async function postJsonOverHttps(
  url: URL,
  payload: unknown,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  rejectUnauthorized: boolean,
): Promise<HttpJsonResponse> {
  return await new Promise<HttpJsonResponse>((resolve, reject) => {
    const req = httpsRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers,
        rejectUnauthorized,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(
            Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
          );
        });
        res.on("end", () => {
          const bodyText = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? "",
            bodyText,
          });
        });
      },
    );

    req.on("error", reject);

    if (signal) {
      const abortHandler = () => req.destroy(new Error("Request aborted"));
      if (signal.aborted) {
        abortHandler();
      } else {
        signal.addEventListener("abort", abortHandler, { once: true });
        req.on("close", () =>
          signal.removeEventListener("abort", abortHandler),
        );
      }
    }

    req.write(JSON.stringify(payload));
    req.end();
  });
}

async function postTavily<T>(
  endpoint: string,
  payload: Record<string, unknown>,
  apiKey: string,
  signal: AbortSignal | undefined,
): Promise<{ json: T; insecureTlsFallbackUsed: boolean; warning?: string }> {
  const requestUrl = new URL(`https://api.tavily.com/${endpoint}`);
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  const parseResponse = (response: HttpJsonResponse): T => {
    if (response.status >= 400) {
      throw new Error(
        `Tavily API error (${response.status}): ${response.statusText}${response.bodyText ? ` - ${response.bodyText}` : ""}`,
      );
    }
    try {
      return JSON.parse(response.bodyText) as T;
    } catch {
      throw new Error("Tavily API returned non-JSON response.");
    }
  };

  try {
    const response = await postJsonOverHttps(
      requestUrl,
      payload,
      headers,
      signal,
      true,
    );
    return { json: parseResponse(response), insecureTlsFallbackUsed: false };
  } catch (err: any) {
    if (err?.name === "AbortError") throw err;
    if (
      !isTlsCertError(err) ||
      process.env.TAVILY_DISABLE_INSECURE_TLS_FALLBACK === "1"
    ) {
      throw new Error(`Tavily request failed: ${buildErrorMessage(err)}`);
    }

    try {
      const response = await postJsonOverHttps(
        requestUrl,
        payload,
        headers,
        signal,
        false,
      );
      return {
        json: parseResponse(response),
        insecureTlsFallbackUsed: true,
        warning:
          "TLS certificate verification failed in this runtime, so Tavily retried with certificate checks disabled for this request. Configure NODE_EXTRA_CA_CERTS with your corporate CA and remove this fallback.",
      };
    } catch (fallbackErr: any) {
      throw new Error(
        `Tavily request failed. TLS verification error detected and insecure fallback also failed. Primary: ${buildErrorMessage(err)} | Fallback: ${buildErrorMessage(fallbackErr)}`,
      );
    }
  }
}

const ExtractParams = Type.Object({
  urls: Type.Array(Type.String({ description: "Public page URL to extract" }), {
    description: "One or more known public URLs to read (1-20)",
    minItems: 1,
    maxItems: 20,
  }),
  query: Type.Optional(
    Type.String({
      description:
        "Question or topic to focus extraction on. With chunksPerSource, returns only the most relevant snippets.",
    }),
  ),
  chunksPerSource: Type.Optional(
    Type.Integer({
      description: "Relevant snippets per URL (1-5); requires query",
      minimum: 1,
      maximum: 5,
    }),
  ),
  extractDepth: Type.Optional(
    Type.Union([Type.Literal("basic"), Type.Literal("advanced")], {
      description:
        "basic for normal pages; advanced for JavaScript-heavy or complex pages",
      default: "basic",
    }),
  ),
  format: Type.Optional(
    Type.Union([Type.Literal("markdown"), Type.Literal("text")], {
      description: "Extracted content format",
      default: "markdown",
    }),
  ),
});

const SearchParams = Type.Object({
  query: Type.String({ description: "Search query string" }),
  maxResults: Type.Optional(
    Type.Integer({
      description: "Maximum number of results to return (1-10)",
      minimum: 1,
      maximum: 10,
      default: 5,
    }),
  ),
  depth: Type.Optional(
    Type.Union([Type.Literal("basic"), Type.Literal("advanced")], {
      description: "Search depth (basic is faster; advanced is broader)",
      default: "basic",
    }),
  ),
  topic: Type.Optional(
    Type.Union([Type.Literal("general"), Type.Literal("news")], {
      description: "Search topic hint",
    }),
  ),
  includeDomains: Type.Optional(
    Type.Array(Type.String(), {
      description: "Only include results from these domains (optional)",
    }),
  ),
  excludeDomains: Type.Optional(
    Type.Array(Type.String(), {
      description: "Exclude results from these domains (optional)",
    }),
  ),
  includeRawContent: Type.Optional(
    Type.Boolean({
      description:
        "Include full raw content snippets from Tavily when available",
      default: false,
    }),
  ),
  days: Type.Optional(
    Type.Integer({
      description: "For news-like queries, prefer recent results within N days",
      minimum: 1,
    }),
  ),
});

export default function (pi: ExtensionAPI) {
  const apiKey = process.env.TAVILY_API_KEY;

  if (!apiKey) {
    pi.on("session_start", async (_event, ctx) => {
      if (ctx.hasUI) {
        ctx.ui.notify(
          "search_web disabled: TAVILY_API_KEY is not set.",
          "warn",
        );
      }
    });
    return;
  }

  pi.registerTool({
    name: "search_web",
    label: "Web Search (Tavily)",
    description:
      `Find current information and candidate sources on the public web. Results are ranked citations with concise excerpts, not full page reads. ` +
      `After choosing a source, use extract_web to read only the relevant page. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first).`,
    promptSnippet:
      "Discover current, citable web sources before reading selected pages.",
    promptGuidelines: [
      "Use search_web to find current public sources; cite the URLs you use.",
      "Use basic by default; once a source is selected, use extract_web to read it.",
    ],
    parameters: SearchParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const query = params.query.trim();
      const maxResults = params.maxResults ?? 5;
      const depth = params.depth ?? "basic";
      const includeRawContent = params.includeRawContent ?? false;

      if (!query) {
        throw new Error("query cannot be empty");
      }

      onUpdate?.({
        content: [{ type: "text", text: `Searching web for: ${query}` }],
        details: {},
      });

      const started = Date.now();

      const body: Record<string, unknown> = {
        api_key: apiKey,
        query,
        max_results: maxResults,
        search_depth: depth,
        include_answer: false,
        include_images: false,
        include_raw_content: includeRawContent,
      };

      if (params.topic) body.topic = params.topic;
      if (params.includeDomains?.length)
        body.include_domains = params.includeDomains;
      if (params.excludeDomains?.length)
        body.exclude_domains = params.excludeDomains;
      if (params.days) body.days = params.days;

      let json: { results?: TavilyResult[] };
      let insecureTlsFallbackUsed = false;
      let warning: string | undefined;
      try {
        const requestUrl = new URL("https://api.tavily.com/search");
        const requestHeaders = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        };

        const primaryResponse = await postJsonOverHttps(
          requestUrl,
          body,
          requestHeaders,
          signal ?? ctx.signal,
          true,
        );

        let responseToUse = primaryResponse;

        if (primaryResponse.status >= 400) {
          throw new Error(
            `Tavily API error (${primaryResponse.status}): ${primaryResponse.statusText}${primaryResponse.bodyText ? ` - ${primaryResponse.bodyText}` : ""}`,
          );
        }

        try {
          json = JSON.parse(responseToUse.bodyText) as {
            results?: TavilyResult[];
          };
        } catch {
          throw new Error("Tavily API returned non-JSON response.");
        }
      } catch (err: any) {
        if (err?.name === "AbortError") throw err;

        if (
          isTlsCertError(err) &&
          process.env.TAVILY_DISABLE_INSECURE_TLS_FALLBACK !== "1"
        ) {
          try {
            const requestUrl = new URL("https://api.tavily.com/search");
            const fallbackResponse = await postJsonOverHttps(
              requestUrl,
              body,
              {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
              },
              signal ?? ctx.signal,
              false,
            );

            if (fallbackResponse.status >= 400) {
              throw new Error(
                `Tavily API error (${fallbackResponse.status}): ${fallbackResponse.statusText}${fallbackResponse.bodyText ? ` - ${fallbackResponse.bodyText}` : ""}`,
              );
            }

            json = JSON.parse(fallbackResponse.bodyText) as {
              results?: TavilyResult[];
            };
            insecureTlsFallbackUsed = true;
            warning =
              "TLS certificate verification failed in this runtime, so search_web retried with certificate checks disabled for this request. Configure NODE_EXTRA_CA_CERTS with your corporate CA and remove this fallback.";
          } catch (fallbackErr: any) {
            throw new Error(
              `Web search failed. TLS verification error detected and insecure fallback also failed. Primary: ${buildErrorMessage(err)} | Fallback: ${buildErrorMessage(fallbackErr)}`,
            );
          }
        } else {
          throw new Error(`Web search failed: ${buildErrorMessage(err)}`);
        }
      }

      const results = (json.results ?? []).slice(0, maxResults);
      const elapsedMs = Date.now() - started;

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: warning
                ? `${warning}\n\nNo web results found.`
                : "No web results found.",
            },
          ],
          details: {
            query,
            maxResults,
            depth,
            topic: params.topic,
            includeDomains: params.includeDomains,
            excludeDomains: params.excludeDomains,
            includeRawContent,
            elapsedMs,
            resultCount: 0,
            results: [],
            insecureTlsFallbackUsed,
            warning,
          } as SearchWebDetails,
        };
      }

      const lines: string[] = [];
      lines.push(`Web results for: \"${query}\"`);
      lines.push(`Returned ${results.length} result(s) in ${elapsedMs}ms`);
      lines.push("");

      results.forEach((r, i) => {
        lines.push(`${i + 1}. ${r.title || "(no title)"}`);
        if (r.url) lines.push(`   URL: ${r.url}`);
        if (typeof r.score === "number")
          lines.push(`   Relevance: ${r.score.toFixed(3)}`);
        if (r.published_date) lines.push(`   Published: ${r.published_date}`);
        if (r.content) lines.push(`   Summary: ${r.content}`);
        lines.push("");
      });

      const fullText = lines.join("\n");
      const truncation = truncateHead(fullText, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      const details: SearchWebDetails = {
        query,
        maxResults,
        depth,
        topic: params.topic,
        includeDomains: params.includeDomains,
        excludeDomains: params.excludeDomains,
        includeRawContent,
        elapsedMs,
        resultCount: results.length,
        results,
        insecureTlsFallbackUsed,
        warning,
      };

      let outputText = truncation.content;
      if (truncation.truncated) {
        const tempDir = await mkdtemp(join(tmpdir(), "pi-search-web-"));
        const tempFile = join(tempDir, "full-output.txt");
        await withFileMutationQueue(tempFile, async () => {
          await writeFile(tempFile, fullText, "utf8");
        });

        details.truncation = truncation;
        details.fullOutputPath = tempFile;

        outputText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
        outputText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
        outputText += ` Full output saved to: ${tempFile}]`;
      }

      return {
        content: [
          {
            type: "text",
            text: warning ? `${warning}\n\n${outputText}` : outputText,
          },
        ],
        details,
      };
    },

    renderCall(args, theme) {
      const query = typeof args.query === "string" ? args.query : "";
      const maxResults =
        typeof args.maxResults === "number" ? args.maxResults : 5;
      let text = theme.fg("toolTitle", theme.bold("search_web "));
      text += theme.fg("accent", `\"${query}\"`);
      text += theme.fg("dim", ` (${maxResults} results)`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);

      const details = result.details as SearchWebDetails | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }

      if (details.resultCount === 0) {
        return new Text(theme.fg("dim", "No results"), 0, 0);
      }

      let header = theme.fg("success", `${details.resultCount} result(s)`);
      header += theme.fg("dim", ` in ${details.elapsedMs}ms`);
      if (details.truncation?.truncated)
        header += theme.fg("warning", " (truncated)");
      if (details.insecureTlsFallbackUsed)
        header += theme.fg("warning", " (TLS fallback)");

      if (!expanded) return new Text(header, 0, 0);

      const lines = [header, ""];
      details.results.slice(0, 5).forEach((r, i) => {
        lines.push(
          `${theme.fg("accent", `${i + 1}.`)} ${r.title || "(no title)"}`,
        );
        if (r.url) lines.push(theme.fg("dim", `   ${r.url}`));
      });
      if (details.fullOutputPath) {
        lines.push("");
        lines.push(theme.fg("dim", `Full output: ${details.fullOutputPath}`));
      }

      return new Text(lines.join("\n"), 0, 0);
    },
  });

  pi.registerTool({
    name: "extract_web",
    label: "Web Extract (Tavily)",
    description:
      `Read selected public pages as clean Markdown or text. Use URLs supplied by the user or chosen with search_web; do not use this for interactive or authenticated sites. ` +
      `Pass query and chunksPerSource to return only the relevant passages. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first).`,
    promptSnippet:
      "Read a chosen web source with focused, citation-ready extraction.",
    promptGuidelines: [
      "Use extract_web for a public URL from the user or search_web; cite it when used.",
      "Use query with 1-3 chunksPerSource for focused reading; omit query only when the full page is needed.",
    ],
    parameters: ExtractParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const inputUrls: string[] = Array.isArray(params.urls)
        ? (params.urls as unknown[]).filter(
            (url): url is string => typeof url === "string",
          )
        : [];
      const urls: string[] = [
        ...new Set(inputUrls.map((url) => url.trim()).filter(Boolean)),
      ];
      const query = params.query?.trim();
      const chunksPerSource = params.chunksPerSource;
      const extractDepth = params.extractDepth ?? "basic";
      const format = params.format ?? "markdown";

      if (urls.length === 0)
        throw new Error("urls must contain at least one non-empty URL");
      if (chunksPerSource && !query) {
        throw new Error(
          "chunksPerSource requires query so Tavily can rank relevant passages",
        );
      }
      for (const url of urls) {
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new Error("unsupported protocol");
          }
        } catch {
          throw new Error(`Invalid public HTTP(S) URL: ${url}`);
        }
      }

      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Extracting ${urls.length} web page${urls.length === 1 ? "" : "s"}`,
          },
        ],
        details: {},
      });

      const started = Date.now();
      const body: Record<string, unknown> = {
        urls,
        extract_depth: extractDepth,
        format,
        include_images: false,
      };
      if (query) body.query = query;
      if (chunksPerSource) body.chunks_per_source = chunksPerSource;

      const response = await postTavily<{
        results?: TavilyExtractResult[];
        failed_results?: TavilyFailedExtractResult[];
      }>("extract", body, apiKey, signal ?? ctx.signal);
      const results = response.json.results ?? [];
      const failedResults = response.json.failed_results ?? [];
      const elapsedMs = Date.now() - started;

      const lines = [
        query ? `Focused web extraction for: \"${query}\"` : "Web extraction",
        `Retrieved ${results.length} page${results.length === 1 ? "" : "s"} in ${elapsedMs}ms`,
        "",
      ];
      results.forEach((result, index) => {
        lines.push(`${index + 1}. ${result.url || "(unknown URL)"}`);
        lines.push(result.raw_content || "(No extractable text returned.)");
        lines.push("");
      });
      if (failedResults.length > 0) {
        lines.push("Failed URLs:");
        failedResults.forEach((result) => {
          lines.push(
            `- ${result.url || "(unknown URL)"}${result.error ? ` — ${result.error}` : ""}`,
          );
        });
      }

      const fullText = lines.join("\n");
      const truncation = truncateHead(fullText, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      const details: ExtractWebDetails = {
        urls,
        query,
        extractDepth,
        format,
        chunksPerSource,
        elapsedMs,
        resultCount: results.length,
        failedResults,
        results,
        insecureTlsFallbackUsed: response.insecureTlsFallbackUsed,
        warning: response.warning,
      };

      let outputText = truncation.content;
      if (truncation.truncated) {
        const tempDir = await mkdtemp(join(tmpdir(), "pi-extract-web-"));
        const tempFile = join(tempDir, "full-output.txt");
        await withFileMutationQueue(tempFile, async () => {
          await writeFile(tempFile, fullText, "utf8");
        });
        details.truncation = truncation;
        details.fullOutputPath = tempFile;
        outputText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
        outputText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
        outputText += ` Full output saved to: ${tempFile}]`;
      }

      return {
        content: [
          {
            type: "text",
            text: response.warning
              ? `${response.warning}\n\n${outputText}`
              : outputText,
          },
        ],
        details,
      };
    },

    renderCall(args, theme) {
      const urls = Array.isArray(args.urls)
        ? args.urls.filter((url): url is string => typeof url === "string")
        : [];
      const query = typeof args.query === "string" ? args.query : undefined;
      let text = theme.fg("toolTitle", theme.bold("extract_web "));
      text += theme.fg(
        "accent",
        `${urls.length} URL${urls.length === 1 ? "" : "s"}`,
      );
      if (query) text += theme.fg("dim", ` — ${query}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial)
        return new Text(theme.fg("warning", "Extracting..."), 0, 0);

      const details = result.details as ExtractWebDetails | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }

      let header = theme.fg(
        "success",
        `${details.resultCount} page${details.resultCount === 1 ? "" : "s"} extracted`,
      );
      header += theme.fg("dim", ` in ${details.elapsedMs}ms`);
      if (details.failedResults.length > 0)
        header += theme.fg(
          "warning",
          ` (${details.failedResults.length} failed)`,
        );
      if (details.truncation?.truncated)
        header += theme.fg("warning", " (truncated)");
      if (details.insecureTlsFallbackUsed)
        header += theme.fg("warning", " (TLS fallback)");
      if (!expanded) return new Text(header, 0, 0);

      const lines = [header, ""];
      details.results.slice(0, 5).forEach((item, index) => {
        lines.push(
          `${theme.fg("accent", `${index + 1}.`)} ${item.url || "(unknown URL)"}`,
        );
      });
      if (details.fullOutputPath) {
        lines.push("");
        lines.push(theme.fg("dim", `Full output: ${details.fullOutputPath}`));
      }
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
