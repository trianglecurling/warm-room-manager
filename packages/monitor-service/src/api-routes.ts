// src/api-routes.ts
import { Router } from 'express';
import {
  getAllMonitorData, // This is now async
  updateMonitorDataAndRemote,
  AllMonitorsData,
  Team,
  TeamText,
  composeTextFromTeam,
} from './service.js';

// Helper function to check if data is a Team
function isTeam(data: Team | TeamText): data is Team {
  return 'teamName' in data && 'contextId' in data;
}

// Helper function to get text representation
function getTextFromData(data: Team | TeamText): string {
  if (isTeam(data)) {
    return composeTextFromTeam(data);
  } else {
    return data.players.join('\n');
  }
}

// Helper function to transform monitor data for API response
function transformMonitorDataForResponse(data: AllMonitorsData): any {
  const transformed: any = {};

  for (const sheetId in data) {
    const sheet = data[sheetId];
    transformed[sheetId] = {
      status: sheet.status,
      ...(sheet.errorMessage && { errorMessage: sheet.errorMessage }),
      red: {
        text: getTextFromData(sheet.red),
        ...(isTeam(sheet.red) && { team: sheet.red }),
      },
      yellow: {
        text: getTextFromData(sheet.yellow),
        ...(isTeam(sheet.yellow) && { team: sheet.yellow }),
      },
    };
  }

  return transformed;
}

const apiRouter = Router();

// Middleware to set common headers
apiRouter.use((req, res, next) => {
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

  // Handle preflight OPTIONS requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  next();
});

/**
 * @swagger
 * openapi: 3.0.0
 * info:
 *   title: Curling Club Monitor Service API
 *   version: 1.0.0
 *   description: API for managing curling sheet display monitors via SSH connections
 *   contact:
 *     name: Curling Club Monitor Service
 * servers:
 *   - url: http://localhost:3000
 *     description: Development server
 *   - url: https://api.curlingclub.com
 *     description: Production server
 * tags:
 *   - name: Monitors
 *     description: Monitor data management operations
 * components:
 *   schemas:
 *     Team:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Optional team ID
 *         teamName:
 *           type: string
 *           description: Name of the team
 *         contextId:
 *           type: integer
 *           description: Context identifier for the team
 *         lead:
 *           type: string
 *           description: Name of the lead player
 *         second:
 *           type: string
 *           description: Name of the second player
 *         third:
 *           type: string
 *           description: Name of the third player
 *         fourth:
 *           type: string
 *           description: Name of the fourth player
 *         vicePosition:
 *           type: string
 *           enum: [lead, second, third, fourth]
 *           description: Vice skip position
 *         skipPosition:
 *           type: string
 *           enum: [lead, second, third, fourth]
 *           description: Skip position
 *         homeClub:
 *           type: string
 *           description: Home club name
 *         createdAt:
 *           type: string
 *           format: date-time
 *           description: Creation timestamp
 *         updatedAt:
 *           type: string
 *           format: date-time
 *           description: Last update timestamp
 *       required:
 *         - teamName
 *         - contextId
 *         - vicePosition
 *         - skipPosition
 *     TeamText:
 *       type: object
 *       properties:
 *         players:
 *           type: array
 *           items:
 *             type: string
 *           description: Array of player names
 *       required:
 *         - players
 *     TeamData:
 *       type: object
 *       properties:
 *         text:
 *           type: string
 *           description: Text representation of the team data
 *         team:
 *           $ref: '#/components/schemas/Team'
 *           description: Original team data (only present if team data was provided)
 *       required:
 *         - text
 *     SheetMonitorData:
 *       type: object
 *       properties:
 *         status:
 *           type: string
 *           enum: [online, error]
 *           description: Connection status of the monitor
 *         errorMessage:
 *           type: string
 *           description: Error message if status is 'error'
 *         red:
 *           $ref: '#/components/schemas/TeamData'
 *         yellow:
 *           $ref: '#/components/schemas/TeamData'
 *       required:
 *         - status
 *         - red
 *         - yellow
 *     AllMonitorsData:
 *       type: object
 *       additionalProperties:
 *         $ref: '#/components/schemas/SheetMonitorData'
 *       description: Object containing monitor data for all sheets (A, B, C, D)
 *     MonitorUpdateResponse:
 *       type: object
 *       properties:
 *         message:
 *           type: string
 *           description: Success or status message
 *         currentData:
 *           $ref: '#/components/schemas/AllMonitorsData'
 *         remoteUpdateStatus:
 *           type: array
 *           items:
 *             type: string
 *           description: Status of remote updates ('fulfilled' or 'rejected')
 *     ErrorResponse:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 *           description: Error message
 */

/**
 * @swagger
 * /api/monitors:
 *   get:
 *     summary: Get all monitor data
 *     description: Retrieves the current text data for all monitors (A, B, C, D) including connection status
 *     tags:
 *       - Monitors
 *     responses:
 *       200:
 *         description: Successfully retrieved monitor data
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AllMonitorsData'
 *             example:
 *               A:
 *                 status: "online"
 *                 red:
 *                   text: "Team Name / Home Club\nPlayer 1\nPlayer 2"
 *                   team:
 *                     id: 1
 *                     teamName: "Team Name"
 *                     contextId: 123
 *                     lead: "Player 1"
 *                     second: "Player 2"
 *                     vicePosition: "third"
 *                     skipPosition: "lead"
 *                     homeClub: "Home Club"
 *                 yellow:
 *                   text: "Player 3\nPlayer 4"
 *               B:
 *                 status: "error"
 *                 errorMessage: "SSH connection timeout"
 *                 red:
 *                   text: "Player 5\nPlayer 6"
 *                 yellow:
 *                   text: "Player 7\nPlayer 8"
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
apiRouter.get('/monitors', async (req, res) => {
  try {
    const data = await getAllMonitorData();
    const transformedData = transformMonitorDataForResponse(data);
    res.status(200).json(transformedData);
  } catch (error) {
    console.error('Error fetching monitor data:', error);
    res.status(500).json({ error: 'Failed to retrieve monitor data' });
  }
});

/**
 * @swagger
 * /api/monitors:
 *   post:
 *     summary: Update monitor data
 *     description: Updates the text data for specified monitors and pushes changes to remote displays
 *     tags:
 *       - Monitors
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties:
 *               $ref: '#/components/schemas/SheetMonitorData'
 *           example:
 *             A:
 *               red:
 *                 players: ["New Player 1", "New Player 2"]
 *               yellow:
 *                 players: ["New Player 3", "New Player 4"]
 *             B:
 *               red:
 *                 players: ["Updated Player 5", "Updated Player 6"]
 *     responses:
 *       200:
 *         description: Monitor data updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/MonitorUpdateResponse'
 *             example:
 *               message: "Monitor data updated successfully"
 *               currentData:
 *                 A:
 *                   status: "online"
 *                   red:
 *                     text: "Updated Team / Club\nNew Player 1\nNew Player 2"
 *                     team:
 *                       teamName: "Updated Team"
 *                       contextId: 456
 *                       lead: "New Player 1"
 *                       second: "New Player 2"
 *                       vicePosition: "third"
 *                       skipPosition: "lead"
 *                       homeClub: "Club"
 *                   yellow:
 *                     text: "New Player 3\nNew Player 4"
 *               remoteUpdateStatus: ["fulfilled", "fulfilled"]
 *       400:
 *         description: Invalid request body
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
apiRouter.post('/monitors', async (req, res) => {
  const updates: Partial<AllMonitorsData> = req.body;

  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  try {
    const { currentData, remoteUpdateStatus } =
      await updateMonitorDataAndRemote(updates);

    const transformedData = transformMonitorDataForResponse(currentData);

    if (remoteUpdateStatus.length > 0) {
      res.status(200).json({
        message: 'Monitor data updated successfully',
        currentData: transformedData,
        remoteUpdateStatus: remoteUpdateStatus.map((r) => r.status),
      });
    } else {
      res.status(200).json({
        message: 'No changes applied or no valid updates provided',
        currentData: transformedData,
      });
    }
  } catch (error) {
    console.error('Error processing monitor update request:', error);
    res.status(500).json({
      error: 'Failed to update monitor data due to internal server error',
    });
  }
});

export { apiRouter };