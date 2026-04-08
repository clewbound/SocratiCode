// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Generate a stable project ID from an absolute folder path.
 * Uses a short SHA-256 prefix so collection names stay Qdrant-friendly.
 *
 * When `SOCRATICODE_PROJECT_ID` is set, that value is used directly instead
 * of hashing the path.  This lets multiple directory trees (e.g. git
 * worktrees) share a single Qdrant index.  The value must contain only
 * characters valid in a Qdrant collection name (`[a-zA-Z0-9_-]`).
 */
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

// ── Linked projects ──────────────────────────────────────────────────────

/** Configuration file name for linked projects */
const SOCRATICODE_CONFIG_FILE = ".socraticode.json";

/** Shape of .socraticode.json */
interface SocratiCodeConfig {
  linkedProjects?: string[];
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
  const collections: Array<{ name: string; label: string }> = [
    { name: collectionName(currentId), label: path.basename(resolvedRoot) },
  ];

  const linked = loadLinkedProjects(resolvedRoot);
  for (const linkedPath of linked) {
    const linkedId = projectIdFromPath(linkedPath);
    // Skip if same project ID (e.g. worktrees sharing SOCRATICODE_PROJECT_ID)
    if (linkedId === currentId) continue;
    collections.push({
      name: collectionName(linkedId),
      label: path.basename(linkedPath),
    });
  }

  return collections;
}
