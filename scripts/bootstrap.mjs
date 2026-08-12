#!/usr/bin/env node
/**
 * Install the Pi setup and its independently managed packages.
 * This script deliberately changes only settings.packages and
 * settings.shellCommandPrefix.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const agentDir = resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
const settingsPath = join(agentDir, "settings.json");
const npmBin = join(agentDir, "npm", "node_modules", ".bin");
const managedFiles = ["AGENTS.md", "APPEND_SYSTEM.md"];

const managedSources = [
  "git:github.com/eggmasonvalue/pi-setup",
  "git:github.com/eggmasonvalue/pi-subagent",
  "git:github.com/monotykamary/pi-toggle-skills",
  "git:github.com/patelparth3/pi-annotations",
  "npm:agent-browser",
  "git:github.com/vercel-labs/skills",
  "git:github.com/anthropics/skills",
];

// Sources previously managed by this setup. They are removed during the
// settings merge but are not installed again during migration.
const legacySources = [
  "npm:pi-toggle-skills",
  "npm:pi-annotations",
  "npm:pi-system-prompt",
  "git:github.com/jandrikus/pi-system-prompt",
];

const desiredPackages = [
  "git:github.com/eggmasonvalue/pi-setup",
  "git:github.com/eggmasonvalue/pi-subagent",
  "git:github.com/monotykamary/pi-toggle-skills",
  "git:github.com/patelparth3/pi-annotations",
  "npm:agent-browser",
  {
    source: "git:github.com/vercel-labs/skills",
    extensions: [],
    skills: ["skills/find-skills"],
    prompts: [],
    themes: [],
  },
  {
    source: "git:github.com/anthropics/skills",
    extensions: [],
    skills: ["skills/skill-creator"],
    prompts: [],
    themes: [],
  },
];

function sourceOf(entry) {
  return typeof entry === "string" ? entry : entry?.source;
}

function runPi(args, env = {}) {
  console.log(`\n> pi ${args.join(" ")}`);
  execFileSync("pi", args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...env },
  });
}

function mergeSettings() {
  mkdirSync(agentDir, { recursive: true });
  let settings = {};
  if (existsSync(settingsPath)) {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  }

  const existing = Array.isArray(settings.packages) ? settings.packages : [];
  const managed = new Set([...managedSources, ...legacySources]);
  settings.packages = [
    ...existing.filter((entry) => !managed.has(sourceOf(entry))),
    ...desiredPackages,
  ];

  // shellCommandPrefix is interpreted by Pi's bash shell. Use $HOME rather
  // than a Windows drive-letter path, which bash would treat literally.
  const pathCommand = 'export PATH="$HOME/.pi/agent/npm/node_modules/.bin:$PATH"';
  const prefix = typeof settings.shellCommandPrefix === "string" ? settings.shellCommandPrefix : "";
  if (!prefix.includes(".pi/agent/npm/node_modules/.bin")) {
    settings.shellCommandPrefix = prefix ? `${prefix}\n${pathCommand}` : pathCommand;
  }

  const temp = join(agentDir, `.settings.${process.pid}.tmp`);
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  renameSync(temp, settingsPath);
}

function removeOldResourceLink(name) {
  const path = join(agentDir, name);
  if (!existsSync(path)) return;
  try {
    if (lstatSync(path).isSymbolicLink()) {
      rmSync(path, { recursive: true, force: true });
      console.log(`Removed old resource link: ${path}`);
    } else {
      console.warn(`Not removing non-link directory: ${path}`);
    }
  } catch (error) {
    console.warn(`Could not inspect ${path}: ${error.message}`);
  }
}

function linkManagedFile(name) {
  const installed = join(agentDir, "git", "github.com", "eggmasonvalue", "pi-setup", name);
  if (!existsSync(installed)) {
    console.warn(`${name} target not found yet: ${installed}`);
    return;
  }

  const target = join(agentDir, name);
  let existing;
  try { existing = lstatSync(target); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing) {
    rmSync(target, { force: true });
  }
  try {
    symlinkSync(installed, target, "file");
    console.log(`Linked ${target} -> ${installed}`);
  } catch (error) {
    throw new Error(`Could not create the ${name} symlink. Enable Windows Developer Mode or run with symlink privileges, then rerun bootstrap. Original error: ${error.message}`);
  }
}

function main() {
  console.log(`Configuring Pi under ${agentDir}`);
  for (const source of managedSources) {
    // Vercel's repository has a dev-only `prepare: husky` hook that is
    // unusable when Pi installs with devDependencies omitted. Its skills do
    // not need repository lifecycle scripts.
    const env = source === "git:github.com/vercel-labs/skills"
      ? { npm_config_ignore_scripts: "true" }
      : {};
    runPi(["install", source], env);
  }
  mergeSettings();
  mkdirSync(npmBin, { recursive: true });
  for (const name of ["extensions", "skills", "prompts", "themes"]) removeOldResourceLink(name);
  for (const name of managedFiles) linkManagedFile(name);
  console.log("\nPi setup bootstrap complete.");
  console.log("Run: pi update --extensions");
  console.log("One-time browser setup (if not already done): agent-browser install");
  console.log("Verify from Pi: agent-browser --version");
}

try {
  main();
} catch (error) {
  console.error(`\nBootstrap failed: ${error.message}`);
  process.exitCode = 1;
}
