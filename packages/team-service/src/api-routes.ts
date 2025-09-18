// src/api-routes.ts
import { Router, Request, Response } from "express";
import { db } from "./database.js";
import { TeamCreateRequest, TeamUpdateRequest, BulkTeamData, ApiResponse, Context } from "./types.js";

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

// Helper function to send API responses
const sendResponse = <T>(res: Response, data?: T, error?: string, message?: string) => {
  const response: ApiResponse<T> = {
    success: !error,
    data,
    error,
    message
  };
  res.status(error ? 400 : 200).json(response);
};

// GET /api/contexts - Get all contexts
router.get("/contexts", (req: Request, res: Response) => {
  try {
    const contexts = db.getContexts();
    sendResponse(res, contexts);
  } catch (error) {
    sendResponse(res, undefined, error instanceof Error ? error.message : 'Unknown error');
  }
});

// POST /api/contexts - Create a context without any teams
router.post("/contexts", (req: Request, res: Response) => {
  try {
    const {
      // prefer simple names, but accept context* names for consistency with other endpoints
      name,
      type,
      startDate,
      endDate,
      contextName,
      contextType,
      contextStartDate,
      contextEndDate,
    } = req.body || {};

    const ctxName: string | undefined = name || contextName;
    const ctxType: 'league' | 'tournament' | 'miscellaneous' | undefined = type || contextType;
    const ctxStart: string | undefined = startDate || contextStartDate;
    const ctxEnd: string | undefined = endDate || contextEndDate;

    if (!ctxName) return sendResponse(res, undefined, 'Context name is required');
    if (!ctxType || (ctxType !== 'league' && ctxType !== 'tournament' && ctxType !== 'miscellaneous')) {
      return sendResponse(res, undefined, "Context type must be 'league', 'tournament', or 'miscellaneous'");
    }
    // Dates are optional. If both provided, validate order.
    if (ctxStart && Number.isNaN(Date.parse(ctxStart))) {
      return sendResponse(res, undefined, 'Invalid date format for startDate');
    }
    if (ctxEnd && Number.isNaN(Date.parse(ctxEnd))) {
      return sendResponse(res, undefined, 'Invalid date format for endDate');
    }
    if (ctxStart && ctxEnd && Date.parse(ctxStart) > Date.parse(ctxEnd)) {
      return sendResponse(res, undefined, 'startDate must be before or equal to endDate');
    }

    // dates optional; already validated if provided above

    // Check duplicate
    const existing = db.getContextByName(ctxName);
    if (existing) {
      return sendResponse(res, undefined, 'Context with this name already exists');
    }

    const created = db.createContext(ctxName, ctxType as 'league' | 'tournament' | 'miscellaneous', ctxStart ?? undefined, ctxEnd ?? undefined);
    sendResponse(res, created, undefined, 'Context created successfully');
  } catch (error) {
    sendResponse(res, undefined, error instanceof Error ? error.message : 'Unknown error');
  }
});

// PUT /api/contexts/:contextName - Update a context
router.put("/contexts/:contextName", (req: Request, res: Response) => {
  try {
    const { contextName } = req.params;
    const { name, type, startDate, endDate } = req.body || {};

    if (type && type !== 'league' && type !== 'tournament' && type !== 'miscellaneous') {
      return sendResponse(res, undefined, "Context type must be 'league', 'tournament', or 'miscellaneous'");
    }
    if (startDate && Number.isNaN(Date.parse(startDate))) {
      return sendResponse(res, undefined, 'Invalid date format for startDate');
    }
    if (endDate && Number.isNaN(Date.parse(endDate))) {
      return sendResponse(res, undefined, 'Invalid date format for endDate');
    }
    if (startDate && endDate && Date.parse(startDate) > Date.parse(endDate)) {
      return sendResponse(res, undefined, 'startDate must be before or equal to endDate');
    }

    const updated = db.updateContext(contextName, { name, type: type as 'league' | 'tournament' | 'miscellaneous' | undefined, startDate, endDate });
    sendResponse(res, updated, undefined, 'Context updated successfully');
  } catch (error) {
    sendResponse(res, undefined, error instanceof Error ? error.message : 'Unknown error');
  }
});

// DELETE /api/contexts/:contextName - Delete a context (and its teams)
router.delete("/contexts/:contextName", (req: Request, res: Response) => {
  try {
    const { contextName } = req.params;

    const existing = db.getContextByName(contextName);
    if (!existing) {
      return sendResponse(res, undefined, 'Context not found');
    }

    const deleted = db.deleteContext(contextName);
    if (!deleted) {
      return sendResponse(res, undefined, 'Failed to delete context');
    }

    sendResponse(res, undefined, undefined, 'Context deleted successfully');
  } catch (error) {
    sendResponse(res, undefined, error instanceof Error ? error.message : 'Unknown error');
  }
});

// GET /api/teams/:contextName - Get all teams for a context
router.get("/teams/:contextName", (req: Request, res: Response) => {
  try {
    const { contextName } = req.params;
    const teams = db.getTeamsByContext(contextName);
    sendResponse(res, teams);
  } catch (error) {
    sendResponse(res, undefined, error instanceof Error ? error.message : 'Unknown error');
  }
});

// GET /api/teams/:contextName/:teamName - Get a specific team
router.get("/teams/:contextName/:teamName", (req: Request, res: Response) => {
  try {
    const { contextName, teamName } = req.params;
    const team = db.getTeam(teamName, contextName);
    
    if (!team) {
      return sendResponse(res, undefined, 'Team not found');
    }
    
    sendResponse(res, team);
  } catch (error) {
    sendResponse(res, undefined, error instanceof Error ? error.message : 'Unknown error');
  }
});

// POST /api/teams - Create a new team
router.post("/teams", (req: Request, res: Response) => {
  try {
    const teamData: TeamCreateRequest = req.body;
    
    // Validate required fields
    if (!teamData.contextName) {
      return sendResponse(res, undefined, 'Context name is required');
    }
    
    if (!teamData.teamName && !teamData.lead && !teamData.second && !teamData.third && !teamData.fourth) {
      return sendResponse(res, undefined, 'Either team name or at least one player name is required');
    }
    
    if (!teamData.contextType) {
      return sendResponse(res, undefined, 'Context type is required');
    }
    
    // Dates optional for context; if provided in team creation, validate order
    if (teamData.contextStartDate && Number.isNaN(Date.parse(teamData.contextStartDate))) {
      return sendResponse(res, undefined, 'Invalid date format for contextStartDate');
    }
    if (teamData.contextEndDate && Number.isNaN(Date.parse(teamData.contextEndDate))) {
      return sendResponse(res, undefined, 'Invalid date format for contextEndDate');
    }
    if (teamData.contextStartDate && teamData.contextEndDate && Date.parse(teamData.contextStartDate) > Date.parse(teamData.contextEndDate)) {
      return sendResponse(res, undefined, 'contextStartDate must be before or equal to contextEndDate');
    }
    
    const team = db.createTeam(teamData);
    sendResponse(res, team, undefined, 'Team created successfully');
  } catch (error) {
    sendResponse(res, undefined, error instanceof Error ? error.message : 'Unknown error');
  }
});

// PUT /api/teams/:contextName/:teamName - Update a team
router.put("/teams/:contextName/:teamName", (req: Request, res: Response) => {
  try {
    const { contextName, teamName } = req.params;
    const updates: TeamUpdateRequest = req.body;
    
    const team = db.updateTeam(teamName, contextName, updates);
    sendResponse(res, team, undefined, 'Team updated successfully');
  } catch (error) {
    sendResponse(res, undefined, error instanceof Error ? error.message : 'Unknown error');
  }
});

// DELETE /api/teams/:contextName/:teamName - Delete a team
router.delete("/teams/:contextName/:teamName", (req: Request, res: Response) => {
  try {
    const { contextName, teamName } = req.params;
    const deleted = db.deleteTeam(teamName, contextName);
    
    if (!deleted) {
      return sendResponse(res, undefined, 'Team not found');
    }
    
    sendResponse(res, undefined, undefined, 'Team deleted successfully');
  } catch (error) {
    sendResponse(res, undefined, error instanceof Error ? error.message : 'Unknown error');
  }
});

// GET /api/search - Search for teams
router.get("/search", (req: Request, res: Response) => {
  try {
    const { contextName, q } = req.query;
    
    if (!contextName || typeof contextName !== 'string') {
      return sendResponse(res, undefined, 'Context name is required');
    }
    
    if (!q || typeof q !== 'string') {
      return sendResponse(res, undefined, 'Search query is required');
    }
    
    const results = db.searchTeams(contextName, q);
    sendResponse(res, results);
  } catch (error) {
    sendResponse(res, undefined, error instanceof Error ? error.message : 'Unknown error');
  }
});

// POST /api/teams/bulk - Bulk create teams
router.post("/teams/bulk", (req: Request, res: Response) => {
  try {
    const bulkData: BulkTeamData = req.body;
    
    // Validate required fields
    if (!bulkData.format) {
      return sendResponse(res, undefined, 'Format string is required');
    }
    
    if (!bulkData.data || !Array.isArray(bulkData.data)) {
      return sendResponse(res, undefined, 'Data array is required');
    }
    
    if (!bulkData.contextName) {
      return sendResponse(res, undefined, 'Context name is required');
    }
    
    if (!bulkData.contextType || (bulkData.contextType !== 'league' && bulkData.contextType !== 'tournament' && bulkData.contextType !== 'miscellaneous')) {
      return sendResponse(res, undefined, "Context type must be 'league', 'tournament', or 'miscellaneous'");
    }
    
    if (!bulkData.contextStartDate || !bulkData.contextEndDate) {
      return sendResponse(res, undefined, 'Context start and end dates are required');
    }
    
    const teams = db.bulkCreateTeams(
      bulkData.format,
      bulkData.data,
      bulkData.contextName,
      bulkData.contextType as 'league' | 'tournament' | 'miscellaneous',
      bulkData.contextStartDate,
      bulkData.contextEndDate
    );
    
    sendResponse(res, teams, undefined, `${teams.length} teams created successfully`);
  } catch (error) {
    sendResponse(res, undefined, error instanceof Error ? error.message : 'Unknown error');
  }
});

// Health check endpoint
router.get("/health", (req: Request, res: Response) => {
  sendResponse(res, { status: 'healthy', timestamp: new Date().toISOString() });
});

export default router;