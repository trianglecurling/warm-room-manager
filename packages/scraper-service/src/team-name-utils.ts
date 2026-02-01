// src/team-name-utils.ts
//
// Lightweight, dependency-free helpers for consistent team-name matching.
// These are used to match scraped game rows back to canonical team records.

export function cleanTeamName(name: string): string {
  // Keep parentheses: many leagues include identifying info in "(...)".
  return String(name || "").replace(/\s+/g, " ").trim();
}

export function stripTrailingParenthetical(name: string): string {
  // Fallback only: handles CCM pages that append "(Skip Lastname)" to a base name.
  return String(name || "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeKeyPart(value: string): string {
  return cleanTeamName(value).toLowerCase();
}

