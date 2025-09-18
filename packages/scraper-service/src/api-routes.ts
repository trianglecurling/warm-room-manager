// src/api-routes.ts
import { Router, Request, Response } from "express";
import {
  getTeamByNameAndLeague, // Renamed
  getTeamById, // New
  getNextGamesBySheet,
  getAllTeams, // New
  getAllGames, // New
  refreshCache,
} from "./ccm-adapter.js";
import { Team, Game } from "./types.js";

const router = Router();

// Middleware to set common headers
router.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept",
  );
  next();
});

/**
 * Checks for a 'refreshCache' query parameter. If 'true', triggers a cache refresh.
 * Must be placed before other route handlers if it applies to them.
 */
router.use(async (req, res, next) => {
  if (req.query.refreshCache === "true") {
    console.log("Manual cache refresh requested via query parameter.");
    const success = await refreshCache();
    if (!success) {
      return res.status(500).json({ error: "Failed to refresh cache." });
    }
  }
  next();
});

/**
 * @swagger
 * /team:
 *   get:
 *     summary: Get team details by name/league or by ID.
 *     parameters:
 *       - in: query
 *         name: teamName
 *         schema:
 *           type: string
 *         required: false
 *         description: The name of the team (required if teamId is not provided).
 *       - in: query
 *         name: leagueName
 *         schema:
 *           type: string
 *         required: false
 *         description: The name of the league (required if teamName is provided).
 *       - in: query
 *         name: teamId
 *         schema:
 *           type: integer
 *         required: false
 *         description: The unique ID of the team (alternative to teamName/leagueName).
 *       - in: query
 *         name: refreshCache
 *         schema:
 *           type: boolean
 *         required: false
 *         description: Set to 'true' to force a cache refresh before fetching.
 *     responses:
 *       200:
 *         description: Team details.
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - $ref: '#/components/schemas/Team'
 *                 - type: 'null'
 *       400:
 *         description: Bad request, missing required parameters or invalid combination.
 *       404:
 *         description: Team not found.
 *       500:
 *         description: Internal server error if cache refresh fails.
 */
router.get("/team", async (req: Request, res: Response<Team | null>) => {
  const { teamName, leagueName, teamId } = req.query;
  let team: Team | null = null;

  if (teamId !== undefined) {
    const id = parseInt(teamId as string, 10);
    if (isNaN(id)) {
      return res.status(400).json(null); // Invalid teamId
    }
    team = await getTeamById(id);
  } else if (typeof teamName === "string" && typeof leagueName === "string") {
    team = await getTeamByNameAndLeague(teamName, leagueName);
  } else {
    return res.status(400).json(null); // Neither teamId nor teamName/leagueName combination provided
  }

  res.status(team ? 200 : 404).json(team);
});

/**
 * @swagger
 * /nextGames:
 *   get:
 *     summary: Get the next N games for each sheet, optionally from a specified date.
 *     parameters:
 *       - in: query
 *         name: count
 *         schema:
 *           type: integer
 *           default: 3
 *         required: false
 *         description: The number of upcoming games to return per sheet.
 *       - in: query
 *         name: fromDate
 *         schema:
 *           type: string
 *           format: date-time
 *         required: false
 *         description: Optional date string (e.g., YYYY-MM-DDTHH:mm:ssZ) to start searching from. Defaults to "now minus 45 minutes".
 *       - in: query
 *         name: refreshCache
 *         schema:
 *           type: boolean
 *         required: false
 *         description: Set to 'true' to force a cache refresh before fetching.
 *     responses:
 *       200:
 *         description: An object where keys are sheet names and values are arrays of Game objects. Empty arrays for sheets with no upcoming games.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties:
 *                 type: array
 *                 items:
 *                   $ref: '#/components/schemas/Game'
 *       400:
 *         description: Bad request, invalid count or date format.
 *       500:
 *         description: Internal server error if cache refresh fails.
 */
router.get("/nextGames", async (req: Request, res: Response<Record<string, Game[]>>) => {
  const { count, fromDate } = req.query;

  let gameCount: number | undefined;
  if (count !== undefined) {
    gameCount = parseInt(count as string, 10);
    if (isNaN(gameCount) || gameCount < 0) {
      return res.status(400).json({}); // Invalid count
    }
  }

  let searchDate: Date | undefined;
  if (fromDate) {
    if (typeof fromDate !== "string" || isNaN(new Date(fromDate).getTime())) {
      return res.status(400).json({}); // Invalid date format
    }
    searchDate = new Date(fromDate);
  }

  const gamesBySheet = await getNextGamesBySheet(gameCount, searchDate); // Pass parsed values
  res.status(200).json(gamesBySheet);
});

/**
 * @swagger
 * /teams:
 *   get:
 *     summary: Get all teams.
 *     parameters:
 *       - in: query
 *         name: refreshCache
 *         schema:
 *           type: boolean
 *         required: false
 *         description: Set to 'true' to force a cache refresh before fetching.
 *     responses:
 *       200:
 *         description: An array of all teams.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Team'
 *       500:
 *         description: Internal server error if cache refresh fails.
 */
router.get("/teams", async (req: Request, res: Response<Team[]>) => {
  const teams = await getAllTeams();
  res.status(200).json(teams);
});

/**
 * @swagger
 * /games:
 *   get:
 *     summary: Get all games.
 *     parameters:
 *       - in: query
 *         name: refreshCache
 *         schema:
 *           type: boolean
 *         required: false
 *         description: Set to 'true' to force a cache refresh before fetching.
 *     responses:
 *       200:
 *         description: An array of all games.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Game'
 *       500:
 *         description: Internal server error if cache refresh fails.
 */
router.get("/games", async (req: Request, res: Response<Game[]>) => {
  const games = await getAllGames();
  res.status(200).json(games);
});

export default router;