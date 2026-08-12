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
const appendPath = join(agentDir, "APPEND_SYSTEM.md");

const managedSources = [
  "git:github.com/eggmasonvalue/pi-setup",
  "git:github.com/eggmasonvalue/pi-subagent",
  "git:github.com/monotykamary/pi-toggle-skills",
  "git:github.com/patelparth3/pi-annotations",
  "git:github.com/jandrikus/pi-system-prompt",
  // Remove the previous npm entries when migrating existing machines.
  "npm:pi-toggle-skills",
  "npm:pi-annotations",
  "npm:pi-system-prompt",
  "npm:agent-browser",
  "git:github.com/vercel-labs/skills",
  "git:github.com/anthropics/skills",
];

const desiredPackages = [
  "git:github.com/eggmasonvalue/pi-setup",
  "git:github.com/eggmasonvalue/pi-subagent",
  "git:github.com/monotykamary/pi-toggle-skills",
  "git:github.com/patelparth3/pi-annotations",
  "git:github.com/jandrikus/pi-system-prompt",
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
  const managed = new Set(managedSources);
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

function linkAppendSystem() {
  const installed = join(agentDir, "git", "github.com", "eggmasonvalue", "pi-setup", "APPEND_SYSTEM.md");
  if (!existsSync(installed)) {
    console.warn(`APPEND_SYSTEM.md target not found yet: ${installed}`);
    return;
  }
  let existing;
  try { existing = lstatSync(appendPath); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing?.isSymbolicLink()) {
    rmSync(appendPath, { force: true });
  } else if (existing) {
    const backup = `${appendPath}.local-backup`;
    if (!existsSync(backup)) renameSync(appendPath, backup);
    else throw new Error(`A regular ${appendPath} already exists and ${backup} is also present; refusing to overwrite either file.`);
    console.warn(`Preserved the previous regular file as ${backup}`);
  }
  try {
    symlinkSync(installed, appendPath, "file");
    console.log(`Linked ${appendPath} -> ${installed}`);
  } catch (error) {
    throw new Error(`Could not create the APPEND_SYSTEM.md symlink. Enable Windows Developer Mode or run with symlink privileges, then rerun bootstrap. Original error: ${error.message}`);
  }
}

function main() {
  console.log(`Configuring Pi under ${agentDir}`);
  for (const source of managedSources) {
    // Vercel's repository has a dev-only `prepare: husky` hook. Pi installs
    // git package dependencies with devDependencies omitted, so that hook is
    // unusable on a fresh checkout. Skills do not need repository lifecycle
    // scripts; suppress them for this resource-only package.
    const env = source === "git:github.com/vercel-labs/skills"
      ? { npm_config_ignore_scripts: "true" }
      : {};
    runPi(["install", source], env);
  }
  mergeSettings();
  mkdirSync(npmBin, { recursive: true });
  for (const name of ["extensions", "skills", "prompts", "themes"]) removeOldResourceLink(name);
  linkAppendSystem();
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
