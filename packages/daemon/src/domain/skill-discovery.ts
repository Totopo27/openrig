// V0.3.0 daemon-skill-discovery — filesystem skill scan + structural
// validation. Closes the gap where profile-resolver only saw skills
// declared in `agent.yaml`'s `resources.skills` + imports, not skills
// dropped at user-library or rig-bundled paths.
//
// The validator's question is now "would Claude Code or Codex actually
// load this when it sees the directory?" — i.e., is there a SKILL.md
// with a name + description + body. The daemon's hardcoded shared
// bundle is no longer the gate.
//
// SC-29 EXCEPTION #7 declared in slice ACK §5.

import { readFileSync, readdirSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { SkillResource } from "./types.js";

export type SkillRuntime = "claude-code" | "codex" | "pi";

export interface SkillDiscoveryPaths {
  runtime: SkillRuntime;
  /** Operator home dir (resolved by the daemon at startup, NOT read
   *  here via os.homedir() so tests can inject a fixture root). */
  homedir: string;
  /** The agent's resolved working directory — rig-bundled skills live
   *  under <cwd>/.claude/skills/ or <cwd>/.agents/skills/. */
  cwd: string;
  /** The rig-spec install dir — bundled domain skills live under
   *  <specInstallDir>/skills/<name>/. Optional: undefined means the
   *  rig was installed in-place and no separate install-dir applies. */
  specInstallDir?: string;
  /** Config-resolved managed catalog root. Defaults to the legacy
   *  <homedir>/.openrig/skills path when omitted for compatibility. */
  skillsRoot?: string;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  /** Any other fields the runtime may consume (allowed-tools, model,
   *  etc.) pass through unchecked — they are not load-bearing for
   *  daemon resource validation. */
  [key: string]: unknown;
}

export type ParseResult =
  | { ok: true; frontmatter: SkillFrontmatter; body: string }
  | { ok: false; reason: string };

export interface SkillRejection {
  path: string;
  reason: string;
}

export interface SkillDiscoveryResult {
  skills: SkillResource[];
  rejected: SkillRejection[];
}

export type SourceKind = "rig_bundled" | "spec_install" | "runtime_user" | "shared_user";

export interface SkillProvenanceEntry {
  id: string;
  path: string;
  sourceRoot: string;
  sourceKind: SourceKind;
  frontmatter: SkillFrontmatter;
  body: string;
  shadowed: boolean;
}

export interface SkillProvenanceResult {
  skills: SkillProvenanceEntry[];
  rejected: SkillRejection[];
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

/** Maximum bytes to read for extracting frontmatter header from SKILL.md.
 *  Prevents loading multi-megabyte skill bodies into memory synchronously. */
const HEAD_READ_BUFFER_SIZE = 64 * 1024;

/** Bounded read of frontmatter from a file without reading the entire document into memory.
 *  Falls back to reading full file only if the closing `---` was not within HEAD_READ_BUFFER_SIZE. */
function readSkillFrontmatterFromFile(filePath: string): ParseResult {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const buf = Buffer.alloc(HEAD_READ_BUFFER_SIZE);
    const bytesRead = readSync(fd, buf, 0, HEAD_READ_BUFFER_SIZE, 0);
    const chunk = buf.toString("utf-8", 0, bytesRead);

    // Look for closing delimiter `\n---`
    const firstDelimiter = chunk.indexOf("---");
    if (firstDelimiter !== -1) {
      const secondDelimiter = chunk.indexOf("\n---", firstDelimiter + 3);
      if (secondDelimiter !== -1) {
        // We found both delimiters in the head chunk
        const remainingAfterSecond = chunk.slice(secondDelimiter + 4);
        const hasBody = remainingAfterSecond.trim().length > 0 || bytesRead === HEAD_READ_BUFFER_SIZE;
        if (hasBody) {
          const fmText = chunk.slice(firstDelimiter + 3, secondDelimiter);
          let parsed: unknown;
          try {
            parsed = parseYaml(fmText);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { ok: false, reason: `frontmatter YAML parse error: ${msg}` };
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return { ok: false, reason: "frontmatter is not a YAML mapping" };
          }
          const fm = parsed as Record<string, unknown>;
          if (typeof fm.name !== "string" || fm.name.trim().length === 0) {
            return { ok: false, reason: "frontmatter missing required `name` field" };
          }
          if (typeof fm.description !== "string" || fm.description.trim().length === 0) {
            return { ok: false, reason: "frontmatter missing required `description` field" };
          }
          return {
            ok: true,
            frontmatter: { ...fm, name: fm.name as string, description: fm.description as string } as SkillFrontmatter,
            body: remainingAfterSecond,
          };
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `SKILL.md read error: ${msg}` };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }

  // Fallback to full file read if frontmatter exceeded HEAD_READ_BUFFER_SIZE or EOF edge cases
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `SKILL.md read error: ${msg}` };
  }
  return parseSkillFrontmatter(content);
}

/** Parse a SKILL.md document into frontmatter + body, validating the
 *  shape Claude Code and Codex both require: a YAML frontmatter block
 *  delimited by `---` lines, with at minimum `name` + `description`
 *  fields, plus a non-empty body. */
export function parseSkillFrontmatter(content: string): ParseResult {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    return { ok: false, reason: "no YAML frontmatter delimited by --- lines" };
  }
  const [, fmText, body] = match;

  let parsed: unknown;
  try {
    parsed = parseYaml(fmText!);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `frontmatter YAML parse error: ${msg}` };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "frontmatter is not a YAML mapping" };
  }
  const fm = parsed as Record<string, unknown>;

  if (typeof fm.name !== "string" || fm.name.trim().length === 0) {
    return { ok: false, reason: "frontmatter missing required `name` field" };
  }
  if (typeof fm.description !== "string" || fm.description.trim().length === 0) {
    return { ok: false, reason: "frontmatter missing required `description` field" };
  }

  if (!body || body.trim().length === 0) {
    return { ok: false, reason: "SKILL.md body is empty (the runtime would have nothing to load)" };
  }

  return {
    ok: true,
    frontmatter: { ...fm, name: fm.name as string, description: fm.description as string } as SkillFrontmatter,
    body,
  };
}

interface CacheEntry {
  mtimeMs: number;
  skills: Array<{ id: string; path: string }>;
  rejected: SkillRejection[];
}

const rootCache = new Map<string, CacheEntry>();

/** Clear the in-memory scan root cache (exposed for tests / cache invalidation). */
export function clearSkillDiscoveryCache(): void {
  rootCache.clear();
  provenanceRootCache.clear();
}

function scanSingleRoot(root: string): { skills: Array<{ id: string; path: string }>; rejected: SkillRejection[] } {
  let rootStat;
  try {
    rootStat = statSync(root);
  } catch {
    return { skills: [], rejected: [] };
  }
  if (!rootStat.isDirectory()) return { skills: [], rejected: [] };

  const cached = rootCache.get(root);
  if (cached && cached.mtimeMs === rootStat.mtimeMs) {
    return { skills: cached.skills, rejected: cached.rejected };
  }

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return { skills: [], rejected: [] };
  }

  const skills: Array<{ id: string; path: string }> = [];
  const rejected: SkillRejection[] = [];

  for (const entry of entries) {
    const skillDir = join(root, entry);
    let stat;
    try { stat = statSync(skillDir); } catch { continue; }
    if (!stat.isDirectory()) continue;

    const skillFile = join(skillDir, "SKILL.md");
    if (!existsSync(skillFile)) continue;

    const parsed = readSkillFrontmatterFromFile(skillFile);
    if (!parsed.ok) {
      rejected.push({ path: skillDir, reason: parsed.reason });
      continue;
    }

    skills.push({ id: parsed.frontmatter.name, path: skillDir });
  }

  rootCache.set(root, { mtimeMs: rootStat.mtimeMs, skills, rejected });
  return { skills, rejected };
}

/** Discover skills for a runtime by scanning the canonical filesystem
 *  paths and structurally validating each candidate. Returns the
 *  accepted skills as SkillResource records (id from frontmatter; path
 *  pointing at the skill directory) plus a list of rejections so the
 *  caller can surface clear errors when validation fails. */
export function discoverSkillsForRuntime(paths: SkillDiscoveryPaths): SkillDiscoveryResult {
  const scanRoots = listScanRoots(paths);
  const skills: SkillResource[] = [];
  const rejected: SkillRejection[] = [];
  const seenIds = new Set<string>();

  for (const root of scanRoots) {
    const result = scanSingleRoot(root);
    rejected.push(...result.rejected);

    for (const skill of result.skills) {
      if (seenIds.has(skill.id)) {
        // Earlier root in the precedence list already provided this
        // id; later occurrences are shadowed by the most-specific-wins
        // rule encoded in listScanRoots ordering.
        continue;
      }
      seenIds.add(skill.id);
      skills.push(skill);
    }
  }

  return { skills, rejected };
}

/** Build the precedence-ordered list of scan roots for a runtime.
 *  Earlier entries win on collision (most-specific-wins): rig-bundled
 *  at cwd > spec-install-dir > user libraries. Within user libraries,
 *  the runtime-specific dir is preferred over the shared
 *  ~/.openrig/skills/ pool so an operator who explicitly installed a
 *  Claude-only or Codex-only version takes precedence over the
 *  cross-runtime one. */
function listScanRoots(paths: SkillDiscoveryPaths): string[] {
  const { runtime, homedir, cwd, specInstallDir } = paths;
  // Managed Pi uses a seat-specific agent dir. Only discover the portable
  // bundle pool here; never borrow a sibling runtime's project/user skills.
  if (runtime === "pi") return specInstallDir ? [join(specInstallDir, "skills")] : [];
  const runtimeDir = runtime === "claude-code" ? ".claude" : ".agents";
  const roots: string[] = [];

  // 1. Rig-bundled at cwd (most-specific; ships with the rig source).
  roots.push(join(cwd, runtimeDir, "skills"));

  // 2. Spec-install-dir bundled (bundled-with-rig but installed at a
  // separate path; e.g., from `rig up <bundle>` extraction).
  if (specInstallDir) roots.push(join(specInstallDir, "skills"));

  // 3. Runtime-specific user library (Claude-only or Codex-only
  // operator install).
  roots.push(join(homedir, runtimeDir, "skills"));

  // 4. Shared user-spec library (cross-runtime operator install via
  // `rig specs add`).
  roots.push(paths.skillsRoot ?? join(homedir, ".openrig", "skills"));

  return roots;
}

function rootToSourceKind(root: string, paths: SkillDiscoveryPaths): SourceKind {
  if (paths.runtime === "pi") return "spec_install";
  const runtimeDir = paths.runtime === "claude-code" ? ".claude" : ".agents";
  const rigBundled = join(paths.cwd, runtimeDir, "skills");
  if (root === rigBundled) return "rig_bundled";
  if (paths.specInstallDir && root === join(paths.specInstallDir, "skills")) return "spec_install";
  const runtimeUser = join(paths.homedir, runtimeDir, "skills");
  if (root === runtimeUser) return "runtime_user";
  return "shared_user";
}

interface ProvenanceCacheEntry {
  mtimeMs: number;
  skills: Array<{
    id: string;
    path: string;
    frontmatter: SkillFrontmatter;
    body: string;
  }>;
  rejected: SkillRejection[];
}

const provenanceRootCache = new Map<string, ProvenanceCacheEntry>();

function scanSingleRootWithProvenance(root: string): {
  skills: Array<{ id: string; path: string; frontmatter: SkillFrontmatter; body: string }>;
  rejected: SkillRejection[];
} {
  let rootStat;
  try {
    rootStat = statSync(root);
  } catch {
    return { skills: [], rejected: [] };
  }
  if (!rootStat.isDirectory()) return { skills: [], rejected: [] };

  const cached = provenanceRootCache.get(root);
  if (cached && cached.mtimeMs === rootStat.mtimeMs) {
    return { skills: cached.skills, rejected: cached.rejected };
  }

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return { skills: [], rejected: [] };
  }

  const skills: Array<{ id: string; path: string; frontmatter: SkillFrontmatter; body: string }> = [];
  const rejected: SkillRejection[] = [];

  for (const entry of entries) {
    const skillDir = join(root, entry);
    let stat;
    try { stat = statSync(skillDir); } catch { continue; }
    if (!stat.isDirectory()) continue;

    const skillFile = join(skillDir, "SKILL.md");
    if (!existsSync(skillFile)) continue;

    const parsed = readSkillFrontmatterFromFile(skillFile);
    if (!parsed.ok) {
      rejected.push({ path: skillDir, reason: parsed.reason });
      continue;
    }

    skills.push({
      id: parsed.frontmatter.name,
      path: skillDir,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
    });
  }

  provenanceRootCache.set(root, { mtimeMs: rootStat.mtimeMs, skills, rejected });
  return { skills, rejected };
}

export function discoverSkillsWithProvenance(paths: SkillDiscoveryPaths): SkillProvenanceResult {
  const scanRoots = listScanRoots(paths);
  const skills: SkillProvenanceEntry[] = [];
  const rejected: SkillRejection[] = [];
  const seenIds = new Set<string>();

  for (const root of scanRoots) {
    const result = scanSingleRootWithProvenance(root);
    rejected.push(...result.rejected);

    for (const skill of result.skills) {
      const sourceKind = rootToSourceKind(root, paths);
      skills.push({
        id: skill.id,
        path: skill.path,
        sourceRoot: root,
        sourceKind,
        frontmatter: skill.frontmatter,
        body: skill.body,
        shadowed: seenIds.has(skill.id),
      });
      seenIds.add(skill.id);
    }
  }

  return { skills, rejected };
}
