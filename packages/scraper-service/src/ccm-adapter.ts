// src/ccm-adapter.ts
import { Team, Game } from "./types.js";
import { getAllTeams as scrapeAllTeams, getAllGames as scrapeAllGames, SHEET_NAMES } from "./ccm-scraper.js"; // Rename for clarity
import fs from "node:fs/promises";
import path from "node:path";

// Define cache file paths
const CACHE_DIR = path.resolve(process.cwd(), "cache"); // Root cache directory
const TEAMS_CACHE_FILE = path.join(CACHE_DIR, "teams.json");
const GAMES_CACHE_FILE = path.join(CACHE_DIR, "games.json");

// In-memory cache to reduce file I/O for frequent requests
interface CacheData {
    teams: Team[];
    games: Game[];
    lastUpdated: Date;
}

let inMemoryCache: CacheData | null = null;
const CACHE_STALE_THRESHOLD_MS = 1000 * 60 * 60; // 1 hour for in-memory staleness

// Background refresh settings
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours (once per day)

let refreshTimeout: NodeJS.Timeout | null = null;
let isRefreshing = false; // Flag to prevent concurrent refreshes

/**
 * Ensures the cache directory exists.
 */
async function ensureCacheDir() {
    await fs.mkdir(CACHE_DIR, { recursive: true });
}

/**
 * Reads data from a cache file.
 * @param filePath The path to the cache file.
 * @returns The parsed data or null if file doesn't exist/is empty.
 */
async function readCache<T>(filePath: string): Promise<T | null> {
    try {
        const data = await fs.readFile(filePath, "utf8");
        return JSON.parse(data) as T;
    } catch (error: any) {
        if (error.code === "ENOENT") {
            // File not found, which is fine for initial run
            return null;
        }
        console.error(`Error reading cache file ${filePath}:`, error);
        return null;
    }
}

/**
 * Writes data to a cache file.
 * @param filePath The path to the cache file.
 * @param data The data to write.
 */
async function writeCache<T>(filePath: string, data: T): Promise<void> {
    try {
        await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
    } catch (error) {
        console.error(`Error writing cache file ${filePath}:`, error);
    }
}

/**
 * Scrapes data, updates in-memory cache, and persists to file cache.
 * @returns True if refresh was successful, false otherwise.
 */
export async function refreshCache(): Promise<boolean> {
    if (isRefreshing) {
        console.log("Cache refresh already in progress. Skipping.");
        return false;
    }

    isRefreshing = true;
    console.log("Starting cache refresh...");
    try {
        await ensureCacheDir();

        // SCRAME TEAMS FIRST, THEN GAMES
        const teams = await scrapeAllTeams(); // Perform team scraping
        const games = await scrapeAllGames(teams); // Pass scraped teams to games scraper
        
        const newCache: CacheData = {
            teams,
            games,
            lastUpdated: new Date(),
        };

        // Ensure game teams are linked to the correct instances from `newCache.teams`
        const teamsMap = new Map<number, Team>();
        newCache.teams.forEach((team) => teamsMap.set(team.teamId, team));

        newCache.games.forEach((game) => {
            const team1FromCache = teamsMap.get(game.team1.teamId);
            const team2FromCache = teamsMap.get(game.team2.teamId);

            // IMPORTANT: Re-link teams from the canonical 'teams' list in newCache
            // This handles cases where `getAllGames` might return "new" Team objects
            // (e.g., if it mocked them, or if it had a partial lookup)
            if (team1FromCache) game.team1 = team1FromCache;
            if (team2FromCache) game.team2 = team2FromCache;


            if (game.team1.league !== game.league || game.team2.league !== game.league) {
                console.warn(`League mismatch for game involving team IDs ${game.team1.teamId} and ${game.team2.teamId}. Game league: ${game.league}, Team1 league: ${game.team1.league}, Team2 league: ${game.team2.league}`);
            }
        });

        // Filter out games with missing or unlinked teams before caching
        const validGames = newCache.games.filter(game =>
            teamsMap.has(game.team1.teamId) && teamsMap.has(game.team2.teamId)
        );

        inMemoryCache = { ...newCache, games: validGames }; // Update in-memory cache with filtered games
        await writeCache(TEAMS_CACHE_FILE, inMemoryCache.teams);
        await writeCache(GAMES_CACHE_FILE, inMemoryCache.games);

        console.log("Cache refresh completed successfully.");
        return true;
    } catch (error) {
        console.error("Failed to refresh cache:", error);
        return false;
    } finally {
        isRefreshing = false;
    }
}

/**
 * Initializes the cache by attempting to load from file, otherwise performs an initial refresh.
 * This function also handles the *initial* call to start the background refresh timer.
 */
export async function initializeCache(): Promise<void> {
    await ensureCacheDir();

    const [cachedTeams, cachedGames] = await Promise.all([
        readCache<Team[]>(TEAMS_CACHE_FILE),
        readCache<Game[]>(GAMES_CACHE_FILE),
    ]);

    if (cachedTeams && cachedGames && cachedTeams.length > 0) {
        // Re-instantiate Dates from strings if loaded from JSON
        cachedGames.forEach((game) => {
            game.date = new Date(game.date);
        });

        const teamsMap = new Map<number, Team>();
        cachedTeams.forEach((team) => teamsMap.set(team.teamId, team));

        cachedGames.forEach((game) => {
            game.team1 = teamsMap.get(game.team1.teamId) || game.team1;
            game.team2 = teamsMap.get(game.team2.teamId) || game.team2;
        });

        inMemoryCache = {
            teams: cachedTeams,
            games: cachedGames,
            lastUpdated: new Date(),
        };
        console.log("Cache loaded from file system.");
    } else {
        console.log("No existing cache found or cache is empty. Performing initial refresh...");
        // Perform initial scrape if no cache
        await refreshCache();
    }

    // Schedule the *next* background refresh, not an immediate one.
    // This ensures that after the initial load/scrape, the timer properly starts for future cycles.
    startBackgroundRefreshTimer();
}

/**
 * Schedules the background cache refresh.
 * This function only schedules the *next* refresh, it does not perform one immediately.
 */
function startBackgroundRefreshTimer() {
    if (refreshTimeout) {
        clearTimeout(refreshTimeout);
    }

    // Schedule the next cache refresh in 24 hours
    console.log(`Scheduling next cache refresh in ${REFRESH_INTERVAL_MS / 1000 / 60 / 60} hours.`);
    
    refreshTimeout = setTimeout(() => {
        refreshCache().finally(() => {
            // After refresh, schedule the next one
            startBackgroundRefreshTimer(); // Reschedule after completion
        });
    }, REFRESH_INTERVAL_MS);
}

/**
 * Retrieves the current cache data.
 * If in-memory cache is stale or not present, attempts to load from file.
 * If still not present, triggers a refresh.
 * @returns The cached data, or null if an error occurred and no data is available.
 */
async function getCachedData(): Promise<CacheData | null> {
    const now = new Date();
    if (
        !inMemoryCache ||
        now.getTime() - inMemoryCache.lastUpdated.getTime() >
        CACHE_STALE_THRESHOLD_MS
    ) {
        console.log("In-memory cache is stale or empty. Attempting to reload from file...");
        await initializeCache(); // This will refresh if no file cache exists
    }
    return inMemoryCache;
}

/**
 * Public API method to get a team by name and league.
 * @param teamName The name of the team.
 * @param leagueName The name of the league.
 * @returns The Team object or null if not found.
 */
export async function getTeamByNameAndLeague(
    teamName: string,
    leagueName: string,
): Promise<Team | null> {
    const cache = await getCachedData();
    if (!cache) {
        console.warn("Cache data not available for getTeamByNameAndLeague request.");
        return null;
    }
    return (
        cache.teams.find(
            (team) =>
                team.name.toLowerCase() === teamName.toLowerCase() &&
                team.league.toLowerCase() === leagueName.toLowerCase(),
        ) || null
    );
}

/**
 * Public API method to get a team by ID.
 * @param teamId The unique ID of the team.
 * @returns The Team object or null if not found.
 */
export async function getTeamById(teamId: number): Promise<Team | null> {
    const cache = await getCachedData();
    if (!cache) {
        console.warn("Cache data not available for getTeamById request.");
        return null;
    }
    return cache.teams.find((team) => team.teamId === teamId) || null;
}

/**
 * Public API method to get all games, grouped by sheet and limited by count.
 * @param count The number of upcoming games to return per sheet. Defaults to 3.
 * @param fromDate Optional date to start searching from. Defaults to "now minus 45 minutes".
 * @returns An object where keys are sheet names and values are arrays of Game objects.
 */
export async function getNextGamesBySheet(
    count: number = 3,
    fromDate?: Date,
  ): Promise<Record<string, Game[]>> {
    const cache = await getCachedData();
    if (!cache) {
      console.warn("Cache data not available for getNextGamesBySheet request.");
      return {}; // Return empty object if no cache
    }
  
    // Default fromDate to "now minus 45 minutes"
    const searchDate = fromDate || new Date(Date.now() - 45 * 60 * 1000);
  
    const upcomingGames: Game[] = cache.games.filter(
      (game) => game.date >= searchDate,
    );
  
    upcomingGames.sort((a, b) => a.date.getTime() - b.date.getTime());
  
    const gamesBySheet: Record<string, Game[]> = {};
  
    // Initialize all sheets with empty arrays
    SHEET_NAMES.forEach((sheet) => {
      gamesBySheet[sheet] = [];
    });
  
    // Populate games for each sheet up to the specified count
    const gamesAddedCount: Record<string, number> = {};
    SHEET_NAMES.forEach(sheet => gamesAddedCount[sheet] = 0); // Initialize counters
  
    for (const game of upcomingGames) {
      const sheetKey = game.sheet; // Assuming game.sheet directly matches SHEET_NAMES values
      if (SHEET_NAMES.includes(sheetKey) && gamesAddedCount[sheetKey] < count) {
        gamesBySheet[sheetKey].push(game);
        gamesAddedCount[sheetKey]++;
      }
    }
  
    return gamesBySheet;
  }

/**
 * Public API method to get all teams.
 * @returns An array of all Team objects.
 */
export async function getAllTeams(): Promise<Team[]> {
    const cache = await getCachedData();
    if (!cache) {
        console.warn("Cache data not available for getAllTeams request.");
        return [];
    }
    return cache.teams;
}

/**
 * Public API method to get all games.
 * @returns An array of all Game objects.
 */
export async function getAllGames(): Promise<Game[]> {
    const cache = await getCachedData();
    if (!cache) {
        console.warn("Cache data not available for getAllGames request.");
        return [];
    }
    return cache.games;
}
