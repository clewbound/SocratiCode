// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ── Branch detection ─────────────────────────────────────────────────────

/**
 * Detect the current git branch for a project path.
 * Returns `null` if the path is not inside a git repository or detection fails.
 */
export function detectGitBranch(projectPath: string): string | null {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: path.resolve(projectPath),
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    // "HEAD" is returned for detached HEAD state — treat as no branch
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

/**
 * Fast HEAD-only branch detection.
 *
 * Reads `.git/HEAD` directly without spawning `git`. For hot paths where the
 * cost of `execFileSync('git', ...)` is unacceptable (e.g. an admin endpoint
 * that fans out across N watchlist entries under M concurrent requests).
 *
 * Returns `null` for: missing `.git`, malformed pointer files, detached HEAD
 * (raw SHA), or symbolic refs that don't point at `refs/heads/*` (tag refs,
 * remote-tracking refs, packed refs without a writable HEAD).
 *
 * Behavior parity vs `detectGitBranch`:
 *   - branch HEAD: same value (e.g. `develop`, `dion/foo`)
 *   - detached HEAD: both return `null`
 *   - sym-ref to non-heads: this returns `null`; `detectGitBranch` would
 *     return e.g. `v1.0.0` via `--abbrev-ref`. Rare in practice for daemon
 *     workflows; callers needing full ref-resolution semantics should keep
 *     using `detectGitBranch`.
 */
export function detectGitBranchFromHead(projectPath: string): string | null {
  try {
    const dotGit = path.join(path.resolve(projectPath), ".git");
    let st: fs.Stats;
    try {
      st = fs.statSync(dotGit);
    } catch {
      return null;
    }

    let gitDir: string;
    if (st.isDirectory()) {
      gitDir = dotGit;
    } else if (st.isFile()) {
      let content: string;
      try {
        content = fs.readFileSync(dotGit, "utf-8");
      } catch {
        return null;
      }
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(content);
      if (!m) return null;
      const raw = m[1];
      gitDir = path.isAbsolute(raw)
        ? raw
        : path.resolve(path.resolve(projectPath), raw);
    } else {
      return null;
    }

    const headPath = path.join(gitDir, "HEAD");
    let head: string;
    try {
      head = fs.readFileSync(headPath, "utf-8").trim();
    } catch {
      return null;
    }
    const refMatch = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return refMatch ? refMatch[1] : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the path to the git common-dir for `projectPath`.
 * For the main repo this is `<repo>/.git`; for a linked worktree this resolves
 * to the main repo's `.git/` directory. Returns null on non-git paths.
 */
export function detectGitCommonDir(projectPath: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: path.resolve(projectPath),
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!out) return null;
    return path.resolve(path.resolve(projectPath), out);
  } catch {
    return null;
  }
}

/**
 * 12-char SHA-256 prefix of the resolved git common-dir for `projectPath`.
 * Stable across all worktrees of the same checkout. Returns null on non-git.
 */
export function gitCommonDirHash(projectPath: string): string | null {
  const cd = detectGitCommonDir(projectPath);
  if (!cd) return null;
  const real = fs.existsSync(cd) ? fs.realpathSync(cd) : cd;
  return createHash("sha256").update(real).digest("hex").slice(0, 12);
}

/** True if per-(repo, branch) keying is active. Daemon mode implies repo-keying. */
export function isRepoKeyingActive(): boolean {
  return (
    process.env.SOCRATICODE_REPO_KEYING === "true" ||
    process.env.SOCRATICODE_DAEMON_MODE === "true"
  );
}

/**
 * Resolve the repo identifier for `projectPath` using the precedence:
 * 1. SOCRATICODE_REPO_ID env var
 * 2. repoId in .socraticode.json
 * 3. gitCommonDirHash (12-hex sha)
 * 4. path-based coreProjectId (legacy fallback for non-git paths)
 */
export function resolveRepoId(projectPath: string): string {
  const envId = process.env.SOCRATICODE_REPO_ID?.trim();
  if (envId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(envId)) {
      throw new Error(
        `SOCRATICODE_REPO_ID must match [a-zA-Z0-9_-]+ but got: "${envId}"`,
      );
    }
    return envId;
  }
  const fromJson = loadRepoIdFromConfig(projectPath);
  if (fromJson) return fromJson;
  const fromGit = gitCommonDirHash(projectPath);
  if (fromGit) return fromGit;
  return coreProjectId(projectPath);
}

/**
 * Sanitize a git branch name for use in Qdrant collection names.
 * Replaces characters outside `[a-zA-Z0-9_-]` with underscores,
 * collapses consecutive underscores, and strips leading/trailing underscores.
 */
export function sanitizeBranchName(branch: string): string {
  return branch
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * Generate a stable project ID from an absolute folder path.
 * Uses a short SHA-256 prefix so collection names stay Qdrant-friendly.
 *
 * When `SOCRATICODE_PROJECT_ID` is set, that value is used directly instead
 * of hashing the path.  This lets multiple directory trees (e.g. git
 * worktrees) share a single Qdrant index.  The value must contain only
 * characters valid in a Qdrant collection name (`[a-zA-Z0-9_-]`).
 *
 * When `SOCRATICODE_BRANCH_AWARE` is `"true"` (and no explicit project ID
 * is set), the current git branch name is appended to the hash, producing
 * a separate set of collections per branch.
 */
/** Read the resolved SHA of HEAD when in detached state. Returns null otherwise. */
export function detectDetachedSha(projectPath: string): string | null {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: path.resolve(projectPath),
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export function projectIdFromPath(folderPath: string): string {
  const explicit = process.env.SOCRATICODE_PROJECT_ID?.trim();
  if (explicit) {
    if (!/^[a-zA-Z0-9_-]+$/.test(explicit)) {
      throw new Error(
        `SOCRATICODE_PROJECT_ID must match [a-zA-Z0-9_-]+ but got: "${explicit}"`,
      );
    }
    return explicit;
  }

  // New: opt-in per-(repo, branch) keying
  if (isRepoKeyingActive()) {
    const repoId = resolveRepoId(folderPath);
    const branch = detectGitBranch(path.resolve(folderPath));
    if (!branch) {
      // Detached HEAD: try to read the current SHA for a stable suffix
      const sha = detectDetachedSha(folderPath);
      if (sha) return `${repoId}__detached_${sha.slice(0, 8)}`;
      // Non-git or shaless detached state: bare repoId
      return repoId;
    }
    const sanitized = sanitizeBranchName(branch);
    return sanitized ? `${repoId}__${sanitized}` : repoId;
  }

  // Legacy: BRANCH_AWARE keeps <pathhash>__<branch>
  let id = coreProjectId(folderPath);
  if (process.env.SOCRATICODE_BRANCH_AWARE === "true") {
    const branch = detectGitBranch(path.resolve(folderPath));
    if (branch) {
      const sanitized = sanitizeBranchName(branch);
      if (sanitized) id = `${id}__${sanitized}`;
    }
  }
  return id;
}

/**
 * Path-based project ID: SHA-256 prefix of the resolved folder path.
 * Used as:
 *  - The legacy keying scheme (without repo-keying active): collection name = `codebase_<coreProjectId>` (or `__<branch>` when BRANCH_AWARE).
 *  - The fallback for non-git paths inside `resolveRepoId`.
 *
 * Linked-projects resolution still uses this directly so different repos
 * resolve to distinct linked collections.
 */
export function coreProjectId(folderPath: string): string {
  const normalized = path.resolve(folderPath);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

/**
 * Derive a Qdrant collection name for a project's code chunks.
 */
export function collectionName(projectId: string): string {
  return `codebase_${projectId}`;
}

/**
 * Derive a Qdrant collection name for a project's code graph.
 */
export function graphCollectionName(projectId: string): string {
  return `codegraph_${projectId}`;
}

/**
 * Derive a Qdrant collection name for a project's context artifacts.
 */
export function contextCollectionName(projectId: string): string {
  return `context_${projectId}`;
}

// ── Symbol graph collections ─────────────────────────────────────────────

/** Top-level metadata point for a project's symbol graph. */
export function symgraphMetaCollectionName(projectId: string): string {
  return `${projectId}_symgraph_meta`;
}

/** Per-file payloads for a project's symbol graph. */
export function symgraphFileCollectionName(projectId: string): string {
  return `${projectId}_symgraph_file`;
}

/** Sharded indices (name index + reverse-call file index). */
export function symgraphIndexCollectionName(projectId: string): string {
  return `${projectId}_symgraph_index`;
}

// ── Linked projects ──────────────────────────────────────────────────────

/** Configuration file name for linked projects */
const SOCRATICODE_CONFIG_FILE = ".socraticode.json";

/** Shape of .socraticode.json */
interface SocratiCodeConfig {
  linkedProjects?: string[];
  repoId?: string;
}

/**
 * Load `repoId` from .socraticode.json if present.
 * Returns null if file is missing, malformed, or repoId is absent/invalid type.
 * Throws if repoId is present but does not match the allowed character set.
 */
export function loadRepoIdFromConfig(projectPath: string): string | null {
  const configPath = path.join(path.resolve(projectPath), SOCRATICODE_CONFIG_FILE);
  let raw: string;
  try {
    if (!fs.existsSync(configPath)) return null;
    raw = fs.readFileSync(configPath, "utf-8");
  } catch {
    return null;
  }
  let parsed: { repoId?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed.repoId !== "string") return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(parsed.repoId)) {
    throw new Error(
      `.socraticode.json repoId must match [a-zA-Z0-9_-]+ but got: "${parsed.repoId}"`,
    );
  }
  return parsed.repoId;
}

/**
 * Load linked project paths from `.socraticode.json` and/or the
 * `SOCRATICODE_LINKED_PROJECTS` env var (comma-separated absolute or relative paths).
 *
 * Returns resolved absolute paths. Invalid/missing paths are silently skipped.
 */
export function loadLinkedProjects(projectPath: string): string[] {
  const resolvedRoot = path.resolve(projectPath);
  const paths = new Set<string>();

  // 1. Read .socraticode.json
  const configPath = path.join(resolvedRoot, SOCRATICODE_CONFIG_FILE);
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf-8");
      const config = JSON.parse(raw) as SocratiCodeConfig;
      if (Array.isArray(config.linkedProjects)) {
        for (const p of config.linkedProjects) {
          if (typeof p === "string" && p.trim()) {
            const resolved = path.resolve(resolvedRoot, p.trim());
            if (resolved !== resolvedRoot && fs.existsSync(resolved)) {
              paths.add(resolved);
            }
          }
        }
      }
    }
  } catch {
    // Malformed JSON or read error — skip silently
  }

  // 2. Read env var (comma-separated)
  const envLinked = process.env.SOCRATICODE_LINKED_PROJECTS?.trim();
  if (envLinked) {
    for (const p of envLinked.split(",")) {
      const trimmed = p.trim();
      if (trimmed) {
        const resolved = path.resolve(resolvedRoot, trimmed);
        if (resolved !== resolvedRoot && fs.existsSync(resolved)) {
          paths.add(resolved);
        }
      }
    }
  }

  return Array.from(paths);
}

/**
 * Resolve linked projects into Qdrant collection descriptors for multi-collection search.
 * Returns an array of { name, label } suitable for `searchMultipleCollections()`.
 * The current project is always first (highest priority for dedup).
 */
export function resolveLinkedCollections(
  projectPath: string,
): Array<{ name: string; label: string }> {
  const resolvedRoot = path.resolve(projectPath);
  const currentId = projectIdFromPath(resolvedRoot);
  const currentCoreId = coreProjectId(resolvedRoot);
  const collections: Array<{ name: string; label: string }> = [
    { name: collectionName(currentId), label: path.basename(resolvedRoot) },
  ];

  const linked = loadLinkedProjects(resolvedRoot);
  for (const linkedPath of linked) {
    // Use base hash (no branch suffix) — linked projects are resolved by their
    // standard collection name regardless of SOCRATICODE_BRANCH_AWARE.
    const linkedId = coreProjectId(linkedPath);
    // Skip if same base project (e.g. worktrees sharing the same path hash)
    if (linkedId === currentCoreId) continue;
    collections.push({
      name: collectionName(linkedId),
      label: path.basename(linkedPath),
    });
  }

  return collections;
}
