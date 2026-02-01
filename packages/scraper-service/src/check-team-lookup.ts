// src/check-team-lookup.ts
//
// Lightweight regression check (no test runner required).
// Run via: `npm -w packages/scraper-service run check:team-lookup`

import assert from "node:assert/strict";
import { cleanTeamName, stripTrailingParenthetical, normalizeKeyPart } from "./team-name-utils.js";

function makeKey(league: string, team: string) {
  return `${normalizeKeyPart(league)}::${normalizeKeyPart(team)}`;
}

// Core invariants for parentheses handling:
assert.equal(cleanTeamName("  LS - Violet  Femmes   (Wishart) "), "LS - Violet Femmes (Wishart)");
assert.equal(stripTrailingParenthetical("LS - Violet Femmes (Wishart)"), "LS - Violet Femmes");
assert.equal(stripTrailingParenthetical("NoParens"), "NoParens");

// Map lookup behavior we rely on in the scraper:
const league = "Monday Night";
const teamsMap = new Map<string, number>();
teamsMap.set(makeKey(league, "Team A (Smith)"), 1);
teamsMap.set(makeKey(league, "Team B"), 2);

// Exact match should win:
assert.equal(teamsMap.get(makeKey(league, "Team A (Smith)")), 1);

// Fallback strip should enable matching when page appends "(...)" but canonical doesn't:
assert.equal(teamsMap.get(makeKey(league, stripTrailingParenthetical("Team B (Jones)"))), 2);

console.log("check-team-lookup: OK");

