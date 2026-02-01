// src/ccm-scraper.ts
import { chromium, Browser, Page, BrowserContext } from "playwright"; // Import BrowserContext
import { Team, Game, Name } from "./types.js";
import { cleanTeamName, normalizeKeyPart, stripTrailingParenthetical } from "./team-name-utils.js";
import dotenv from "dotenv";
import fs from "node:fs/promises";
import path from "node:path";

dotenv.config();

const BASE_URL = process.env.BASE_URL || "https://trianglecurling.com";
const ADMIN_LOGIN_URL = `${BASE_URL}/administrator`;
const TEAMS_LIST_URL = `${ADMIN_LOGIN_URL}/index.php?task=teams&option=com_curling`;
const EDIT_TEAM_BASE_URL = `${ADMIN_LOGIN_URL}/index.php?option=com_curling&task=editTeam`;
const GAMES_LIST_BASE_URL = `${ADMIN_LOGIN_URL}/index.php?task=games&option=com_curling`;
const SCREENSHOTS_DIR = path.resolve(process.cwd(), "logs", "screenshots");
export const SHEET_NAMES = (process.env.SHEET_NAMES || "A,B,C,D").split(",").map((s) => s.trim().toUpperCase());

// --- Configuration for Parallelism ---
const MAX_CONCURRENT_PAGES = parseInt(process.env.MAX_CONCURRENCY || "5", 10); // Max number of Playwright pages to open simultaneously

// --- Helper Functions ---

/**
 * Ensures the screenshots directory exists.
 */
async function ensureScreenshotsDir() {
  await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
}

/**
 * Takes a screenshot of the given page and saves it to the screenshots directory.
 * @param page The Playwright Page object.
 * @param filename A base filename for the screenshot (e.g., "login_error", "team_scrape_failed").
 * @returns The full path to the saved screenshot, or null if an error occurred.
 */
async function takeScreenshot(page: Page, filename: string): Promise<string | null> {
  try {
    await ensureScreenshotsDir();
    const timestamp = new Date().toISOString().replace(/:/g, "-"); // ISO format with colon replaced for valid filename
    const filePath = path.join(SCREENSHOTS_DIR, `${filename}_${timestamp}.png`);
    await page.screenshot({ path: filePath });
    console.log(`Playwright: Screenshot saved to ${filePath}`);
    return filePath;
  } catch (error) {
    console.error("Playwright: Failed to take screenshot:", error);
    return null;
  }
}

/**
 * Parses a "Last name, first name" string into a Name object.
 * @param fullName The full name string.
 * @returns A Name object or null if parsing fails.
 */
function parseFullName(fullName: string | null | undefined): Name {
  if (!fullName) return { first: "", last: "" };
  const parts = fullName.split(",").map((s) => s.trim());
  if (parts.length === 2) {
    return { last: parts[0], first: parts[1] };
  }
  return { last: fullName, first: "" };
}

/**
 * Parses a date string like "MM-DD-YYYY H:MM XM" into a Date object.
 * Adjusts for potential discrepancies like "12 PM" being noon.
 * @param dateStr The date string from the scraper.
 * @returns A Date object.
 */
function parseGameDate(dateStr: string): Date {
  // Example: "07-20-2025 7:00 PM"
  const [datePart, timePart, ampm] = dateStr.split(/[\s]/);
  const [month, day, year] = datePart.split('-').map(Number);
  let [hours, minutes] = timePart.split(':').map(Number);

  if (ampm === 'PM' && hours !== 12) {
    hours += 12;
  } else if (ampm === 'AM' && hours === 12) { // Midnight (12 AM is 0 hours)
    hours = 0;
  }

  // Month is 0-indexed in Date constructor
  return new Date(year, month - 1, day, hours, minutes);
}


// Helper to chunk an array into smaller arrays
function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

// --- Playwright Browser and Page Management ---

let browser: Browser | null = null;
let context: BrowserContext | null = null; // NEW: Global context
let isLoggedIn = false;
let initialNavigationPage: Page | null = null; // Renamed from loginPage for clarity, it's the main sequential navigation page

async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await chromium.launch({ headless: true }); // set to false for debugging UI
  }
  return browser;
}

// NEW: Function to get or create the shared context
async function getBrowserContext(): Promise<BrowserContext> {
  if (!context) {
    const currentBrowser = await getBrowser();
    context = await currentBrowser.newContext(); // Create a new context
  }
  return context;
}

async function login(): Promise<boolean> {
  if (isLoggedIn) {
    console.log("Playwright: Already logged in.");
    return true;
  }

  const user = process.env.CCM_USER;
  const pass = process.env.CCM_PASS;

  if (!user || !pass) {
    console.error(
      "Playwright: CCM_USER or CCM_PASS environment variables are not set.",
    );
    throw new Error("CCM credentials not set.");
  }

  const currentContext = await getBrowserContext(); // Use the shared context
  if (!initialNavigationPage) {
    initialNavigationPage = await currentContext.newPage(); // Create page from context
  }

  console.log("Playwright: Navigating to login page...");
  await initialNavigationPage.goto(ADMIN_LOGIN_URL);

  const logoutButton = await initialNavigationPage.$('a[href*="task=logout"]');
  if (logoutButton) {
    console.log("Playwright: Already logged in from previous session.");
    isLoggedIn = true;
    return true;
  }

  console.log("Playwright: Logging in...");
  await initialNavigationPage.fill("#mod-login-username", user);
  await initialNavigationPage.fill("#mod-login-password", pass);
  await initialNavigationPage.click("button.login-button");

  try {
    await initialNavigationPage.waitForSelector("#status", { timeout: 10000 });
    console.log("Playwright: Login successful.");
    isLoggedIn = true;
    return true;
  } catch (error) {
    console.error("Playwright: Login failed. Check credentials or selectors.", error);
    await closeBrowser(); // Close browser if login fails
    throw new Error("Playwright login failed.");
  }
}

/**
 * Closes the Playwright browser instance.
 * Call this when your application shuts down to clean up resources.
 */
export async function closeBrowser(): Promise<void> {
  if (browser) { // Browser instance implicitly closes all contexts and pages
    console.log("Playwright: Closing browser...");
    await browser.close();
    browser = null;
    context = null; // Reset context
    initialNavigationPage = null; // Reset page
    isLoggedIn = false;
  }
}

// --- Scraper Functions ---

interface ScrapedTeamData {
  teamId: number;
  name: string;
  league: string;
  skip: string;
  vice: string;
  second: string;
  lead: string;
}

interface ScrapedGameData {
  date: string;
  sheet: string;
  teamNames: string; // e.g., "Team A VS. Team B"
}

/**
 * Scrapes all teams from CCM.
 * @returns An array of Team objects.
 */
export async function getAllTeams(): Promise<Team[]> {
  console.log("Scraping: Fetching all teams...");
  await login();
  const currentContext = await getBrowserContext(); // Use the shared context

  const allTeams: Team[] = [];

  console.log("Scraping: Navigating to teams list page (using initialNavigationPage)...");
  if (!initialNavigationPage) throw new Error("Initial navigation page not initialized.");
  await initialNavigationPage.goto(TEAMS_LIST_URL); // Use initialNavigationPage for sequential steps

  // 1. Get all league IDs
  const leagueIds: number[] = await initialNavigationPage.evaluate(() => {
    const selectElement = document.querySelector('select[name="league_id"]');
    if (!selectElement) return [];
    return Array.from(selectElement.querySelectorAll("option"))
      .map((option) => parseInt(option.value, 10))
      .filter((id) => id > 0); // Ignore league ID 0
  });

  // leagueIds.splice(1, leagueIds.length - 1);

  console.log(`Scraping: Found ${leagueIds.length} leagues: ${leagueIds.join(", ")}`);

  const uniqueTeamsMap = new Map<number, Team>();

  for (const leagueId of leagueIds) {
    console.log(`Scraping: Navigating to league ID ${leagueId} team list...`);
    await initialNavigationPage.goto(`${TEAMS_LIST_URL}&league_id=${leagueId}`);

    const currentLeagueName: string | null = await initialNavigationPage.evaluate(() => {
      const selectElement = document.querySelector('select[name="league_id"] option[selected]');
      return selectElement ? (selectElement as HTMLElement).innerText.trim() : null;
    });

    if (!currentLeagueName) {
      console.warn(`Could not determine league name for ID ${leagueId}. Skipping.`);
      continue;
    }

    const teamIdsInLeague: number[] = await initialNavigationPage.evaluate(() => {
      const links = document.querySelectorAll("table tr td:nth-child(3) a");
      return [...links]
        .map((n) => {
          const href = n.getAttribute("href");
          if (!href) return null;
          const match = href.match(/cid\[\]=(\d+)/);
          return match ? parseInt(match[1], 10) : null;
        })
        .filter((id): id is number => id !== null);
    });

    console.log(
      `Scraping: Found ${teamIdsInLeague.length} teams in "${currentLeagueName}" (ID ${leagueId}).`,
    );

    const teamIdChunks = chunkArray(teamIdsInLeague, MAX_CONCURRENT_PAGES);

    for (const chunk of teamIdChunks) {
      const teamPromises = chunk.map(async (teamId) => {
        const teamDetailPage = await currentContext.newPage();
        try {
          // console.log(`Scraping: Fetching details for Team ID ${teamId} on new page...`); // Too verbose
          await teamDetailPage.goto(`${EDIT_TEAM_BASE_URL}&cid[]=${teamId}`);
          teamDetailPage.pause();
          const teamData: ScrapedTeamData = await teamDetailPage.evaluate(
            (args: { leagueName: string; currentTeamId: number }) => {
              const { leagueName, currentTeamId } = args;

              const nameInput = document.querySelector('input[name="team_name"]') as HTMLInputElement;
              const skipElement = document.querySelector("#skip_id option[selected]") as HTMLElement;
              const viceElement = document.querySelector("#mate_id option[selected]") as HTMLElement;
              const secondElement = document.querySelector("#second_id option[selected]") as HTMLElement;
              const leadElement = document.querySelector("#lead_id option[selected]") as HTMLElement;

              return {
                teamId: currentTeamId,
                name: nameInput?.value || "N/A",
                league: leagueName,
                skip: skipElement?.innerText || "N/A",
                vice: viceElement?.innerText || "N/A",
                second: secondElement?.innerText || "N/A",
                lead: leadElement?.innerText || "N/A",
              };
            },
            { leagueName: currentLeagueName, currentTeamId: teamId },
          );

          const team: Team = {
            teamId: teamData.teamId,
            name: teamData.name,
            league: teamData.league,
            skip: parseFullName(teamData.skip),
            vice: parseFullName(teamData.vice),
            second: parseFullName(teamData.second),
            lead: parseFullName(teamData.lead),
          };
          uniqueTeamsMap.set(team.teamId, team);
          return team;
        } catch (error) {
          console.error(`Error fetching details for team ID ${teamId}:`, error);
          return null;
        } finally {
          await teamDetailPage.close();
        }
      });
      await Promise.all(teamPromises);
    }
  }

  console.log(`Scraping: Finished fetching all ${uniqueTeamsMap.size} unique teams.`);
  return Array.from(uniqueTeamsMap.values());
}

/**
 * Scrapes all games from CCM for the given leagues, referencing provided teams.
 * @param allTeams The array of all scraped Team objects (needed for linking).
 * @returns An array of Game objects.
 */
export async function getAllGames(allTeams: Team[]): Promise<Game[]> {
  console.log("Scraping: Fetching all games...");
  await login();
  const currentContext = await getBrowserContext();

  const allGames: Game[] = [];
  // CHANGE: Map team by composite key: "league::teamName"
  const teamsMap = new Map<string, Team>();
  allTeams.forEach((team) => {
    const leagueKey = normalizeKeyPart(team.league);
    const exactNameKey = normalizeKeyPart(cleanTeamName(team.name));
    teamsMap.set(`${leagueKey}::${exactNameKey}`, team);
  });

  const lookupTeamForLeague = (leagueName: string, scrapedTeamName: string): Team | undefined => {
    const leagueKey = normalizeKeyPart(leagueName);
    const exact = cleanTeamName(scrapedTeamName);
    const exactKey = `${leagueKey}::${normalizeKeyPart(exact)}`;
    const exactHit = teamsMap.get(exactKey);
    if (exactHit) return exactHit;

    const stripped = stripTrailingParenthetical(scrapedTeamName);
    if (stripped && stripped !== scrapedTeamName) {
      const strippedKey = `${leagueKey}::${normalizeKeyPart(stripped)}`;
      return teamsMap.get(strippedKey);
    }
    return undefined;
  };

  // 1. Get all league IDs (re-using logic from getAllTeams for consistency)
  if (!initialNavigationPage) throw new Error("Initial navigation page not initialized for game scraping.");
  await initialNavigationPage.goto(TEAMS_LIST_URL); // Navigate here to get league IDs first

  const leagueIds: number[] = await initialNavigationPage.evaluate(() => {
    const selectElement = document.querySelector('select[name="league_id"]');
    if (!selectElement) return [];
    return Array.from(selectElement.querySelectorAll("option"))
      .map((option) => parseInt(option.value, 10))
      .filter((id) => id > 0);
  });
  console.log(`Scraping: Found ${leagueIds.length} leagues for games: ${leagueIds.join(", ")}`);

  // Process leagues in chunks for game scraping as well
  const leagueIdChunks = chunkArray(leagueIds, MAX_CONCURRENT_PAGES);

  for (const chunk of leagueIdChunks) {
    const leagueGamePromises = chunk.map(async (leagueId) => {
      const leagueGamePage = await currentContext.newPage();
      try {
        console.log(`Scraping: Navigating to league ID ${leagueId} games list...`);
        await leagueGamePage.goto(`${GAMES_LIST_BASE_URL}&league_id=${leagueId}`);

        const currentLeagueName: string | null = await leagueGamePage.evaluate(() => {
          const selectElement = document.querySelector('select[name="league_id"] option[selected]');
          return selectElement ? (selectElement as HTMLElement).innerText.trim() : null;
        });

        if (!currentLeagueName) {
          await takeScreenshot(leagueGamePage, `league_id_${leagueId}_games_list_error`);
          console.warn(`Could not determine league name for ID ${leagueId} (games). Skipping.`);
          return []; // Return empty array for this league
        }

        const scrapedGamesData: ScrapedGameData[] = await leagueGamePage.evaluate((args: { SHEET_NAMES: string[] }) => {
          const gameRows = document.querySelectorAll("table.table-striped tbody tr");
          const games: ScrapedGameData[] = [];
          gameRows.forEach((row) => {
            const cells = row.querySelectorAll("td");
            if (cells.length >= 5) { // Ensure enough columns
              const date = cells[4]?.innerText.trim() || ""; // 5th td is index 4
              const sheet = cells[3]?.innerText.trim() || ""; // 4th td is index 3
              const teamNames = cells[2]?.innerText.trim() || ""; // 3rd td is index 2

              if (args.SHEET_NAMES.includes(sheet.toUpperCase())) {
                games.push({ date, sheet, teamNames });
              }
            }
          });
          return games;
        }, { SHEET_NAMES });

        const gamesForLeague: Game[] = [];
        for (const scrapedGame of scrapedGamesData) {
          const [rawTeam1Name, rawTeam2Name] = scrapedGame.teamNames
            .split(" VS. ")
            .map((name) => name.trim());

          const team1Name = cleanTeamName(rawTeam1Name || "");
          const team2Name = cleanTeamName(rawTeam2Name || "");

          const team1 = lookupTeamForLeague(currentLeagueName, rawTeam1Name || "");
          const team2 = lookupTeamForLeague(currentLeagueName, rawTeam2Name || "");

          if (team1 && team2) {
            // Also, double-check the invariant check logic. The `game.league` field needs to be established.
            // For games from this specific league page, `game.league` *should* be `currentLeagueName`.
            gamesForLeague.push({
              date: parseGameDate(scrapedGame.date),
              league: currentLeagueName, // Set the game's league from the page context
              sheet: scrapedGame.sheet,
              team1: team1,
              team2: team2,
            });
          } else {
            const shouldWarn =
              Boolean(team1Name) &&
              Boolean(team2Name) &&
              team1Name.toUpperCase() !== "NOT SET" &&
              team2Name.toUpperCase() !== "NOT SET";
            if (shouldWarn) {
              console.warn(
                `Scraping: Could not find teams for game "${scrapedGame.teamNames}" in league "${currentLeagueName}". Skipping game. Team1 Found: ${!!team1}, Team2 Found: ${!!team2}`,
              );
            }
          }
        }
        return gamesForLeague;
      } catch (error) {
        console.error(`Error fetching games for league ID ${leagueId}:`, error);
        return [];
      } finally {
        await leagueGamePage.close();
      }
    });
    const results = await Promise.all(leagueGamePromises);
    results.forEach((gamesInLeague) => allGames.push(...gamesInLeague));
  }

  console.log(`Scraping: Finished fetching all ${allGames.length} games.`);
  return allGames;
}

// Ensure the browser is closed when the process exits
// Using process.once for single execution, as multiple listeners can cause issues
process.once("exit", async () => {
  await closeBrowser();
});
process.once("SIGINT", async () => {
  console.log("Received SIGINT. Shutting down gracefully...");
  await closeBrowser();
  process.exit(0);
});
process.once("SIGTERM", async () => {
  console.log("Received SIGTERM. Shutting down gracefully...");
  await closeBrowser();
  process.exit(0);
});