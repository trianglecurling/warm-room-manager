// src/service.ts
import dotenv from 'dotenv';
import { Client, ConnectConfig } from 'ssh2';
import fs from 'fs';

dotenv.config();

// ... (Data Structure Definitions - unchanged) ...
export interface TeamText {
  players: string[];
}

export interface Team {
  id?: number;
  teamName: string;
  contextId: number;
  lead?: string;
  second?: string;
  third?: string;
  fourth?: string;
  vicePosition: 'lead' | 'second' | 'third' | 'fourth';
  skipPosition: 'lead' | 'second' | 'third' | 'fourth';
  homeClub?: string;
  createdAt?: string;
  updatedAt?: string;
}

export function composeTextFromTeam(team: Team): string {
  const players = [team.fourth || '', team.third || '', team.second || '', team.lead || ''];
  const posToIndex: Record<'lead' | 'second' | 'third' | 'fourth', number> = { fourth: 0, third: 1, second: 2, lead: 3 };
  const marked = players.map((name, idx) => {
    let out = name;
    if (team.skipPosition && team.skipPosition !== 'fourth' && posToIndex[team.skipPosition] === idx && out) out = `${out}*`;
    if (team.vicePosition && team.vicePosition !== 'third' && posToIndex[team.vicePosition] === idx && out) out = `${out}**`;
    return out;
  });
  let playerLines = marked.filter(l => /[A-Za-z]/.test(l));
  const headerText = team.teamName && team.homeClub ? `${team.teamName} - ${team.homeClub}` : (team.homeClub || team.teamName || '');
  const includeHeader = Boolean(headerText) && (playerLines.length === 2 || playerLines.length === 4);
  const lines = includeHeader ? [headerText, ...playerLines] : playerLines;
  return lines.join('\n');
}

// Helper functions to handle Team | TeamText union type
function isTeam(data: Team | TeamText): data is Team {
  return 'teamName' in data && 'contextId' in data;
}

function getTextRepresentation(data: Team | TeamText): string {
  if (isTeam(data)) {
    return composeTextFromTeam(data);
  } else {
    return data.players.join('\n');
  }
}

function getPlayersFromData(data: Team | TeamText): string[] {
  if (isTeam(data)) {
    return getTextRepresentation(data).split('\n');
  } else {
    return data.players;
  }
}

export interface SheetMonitorData {
  red: Team | TeamText;
  yellow: Team | TeamText;
  status: 'online' | 'error';
  errorMessage?: string;
}

export interface AllMonitorsData {
  [sheetId: string]: SheetMonitorData;
}

// --- SSH Configuration Mapping (unchanged) ---
interface MonitorSSHConfig {
  host: string;
  username: string;
  port: number;
  redPath: string;
  yellowPath: string;
}

// SSH timeout configuration
const SSH_TIMEOUT_MS = parseInt(process.env.SSH_TIMEOUT_SECONDS || '5', 10) * 1000;

const monitorConfigs: { [key: string]: MonitorSSHConfig } = {
  A: {
    host: process.env.SHEET_A_HOST!,
    username: process.env.SHEET_A_USER!,
    port: parseInt(process.env.SHEET_A_PORT || '22', 10),
    redPath: process.env.SHEET_A_RED_PATH!,
    yellowPath: process.env.SHEET_A_YELLOW_PATH!,
  },
  B: {
    host: process.env.SHEET_B_HOST!,
    username: process.env.SHEET_B_USER!,
    port: parseInt(process.env.SHEET_B_PORT || '22', 10),
    redPath: process.env.SHEET_B_RED_PATH!,
    yellowPath: process.env.SHEET_B_YELLOW_PATH!,
  },
  C: {
    host: process.env.SHEET_C_HOST!,
    username: process.env.SHEET_C_USER!,
    port: parseInt(process.env.SHEET_C_PORT || '22', 10),
    redPath: process.env.SHEET_C_RED_PATH!,
    yellowPath: process.env.SHEET_C_YELLOW_PATH!,
  },
  D: {
    host: process.env.SHEET_D_HOST!,
    username: process.env.SHEET_D_USER!,
    port: parseInt(process.env.SHEET_D_PORT || '22', 10),
    redPath: process.env.SHEET_D_RED_PATH!,
    yellowPath: process.env.SHEET_D_YELLOW_PATH!,
  },
};

// --- In-memory store for monitor data (now updated by cache logic) ---
const monitors: AllMonitorsData = {
  A: {
    red: { players: [] },
    yellow: { players: [] },
    status: 'online',
  },
  B: {
    red: { players: [] },
    yellow: { players: [] },
    status: 'online',
  },
  C: {
    red: { players: [] },
    yellow: { players: [] },
    status: 'online',
  },
  D: {
    red: { players: [] },
    yellow: { players: [] },
    status: 'online',
  },
};

// --- Caching Layer ---
interface CachedMonitorData {
  data: AllMonitorsData;
  timestamp: number; // Unix timestamp in milliseconds
}

let monitorCache: CachedMonitorData | null = null;
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_SECONDS || '60', 10) * 1000;

/**
 * Attempts to read a text file from a remote monitor via SSH.
 * @param sheetId The ID of the sheet.
 * @param filePath The path to the file to read (e.g., red or yellow text file).
 * @returns A Promise that resolves with the file content as a string, or rejects on error.
 */
async function readRemoteFile(
  sheetId: string,
  filePath: string,
): Promise<string> {
  const config = monitorConfigs[sheetId];
  if (!config) {
    return Promise.reject(new Error(`No SSH configuration found for sheet: ${sheetId}`));
  }

  const conn = new Client();
  const connectConfig: ConnectConfig = {
    host: config.host,
    port: config.port,
    username: config.username,
    readyTimeout: SSH_TIMEOUT_MS,
  };

  if (process.env.SSH_PRIVATE_KEY_PATH) {
    try {
      connectConfig.privateKey = fs.readFileSync(
        process.env.SSH_PRIVATE_KEY_PATH,
      );
    } catch (error) {
      return Promise.reject(new Error(`Failed to load SSH private key: ${error}`));
    }
  } else if (process.env.SSH_PASSWORD) {
    connectConfig.password = process.env.SSH_PASSWORD;
  } else {
    return Promise.reject(new Error('SSH authentication method not configured'));
  }

  return new Promise<string>((resolve, reject) => {
    conn
      .on('ready', () => {
        const command = `cat ${filePath}`;
        conn.exec(command, (err, stream) => {
          if (err) {
            conn.end();
            return reject(new Error(`Failed to execute 'cat' command for ${filePath} on ${sheetId}: ${err}`));
          }

          let data = '';
          stream
            .on('data', (chunk: Buffer) => {
              data += chunk.toString();
            })
            .on('close', (code: number, signal: string) => {
              conn.end();
              if (code !== 0) {
                return reject(new Error(`'cat' command for ${filePath} on ${sheetId} exited with code ${code}`));
              }
              resolve(data.trim()); // Trim whitespace, especially newlines
            })
            .stderr.on('data', (stderrData: Buffer) => {
              console.error(
                `Stderr from 'cat' command on ${sheetId} for ${filePath}: ${stderrData.toString()}`,
              );
              // Don't reject just on stderr, but log it
            });
        });
      })
      .on('error', (err: Error) => {
        reject(new Error(`SSH connection error for sheet ${sheetId}: ${err.message}`));
      })
      .connect(connectConfig);
  });
}

/**
 * Fetches the current text data from all remote monitors in parallel.
 * Updates the in-memory 'monitors' object with the fresh data.
 * @returns A Promise that resolves when all fetches are complete.
 */
export async function updateMonitorsFromRemote(): Promise<void> {
  console.log('Fetching fresh monitor data from remotes...');
  const sheetIds = Object.keys(monitorConfigs);
  const fetchPromises = sheetIds.map(async (sheetId) => {
    const config = monitorConfigs[sheetId];
    if (!config) {
      console.warn(`No config for ${sheetId}, skipping remote fetch.`);
      return null;
    }

    try {
      const redText = await readRemoteFile(sheetId, config.redPath);
      const yellowText = await readRemoteFile(sheetId, config.yellowPath);

      // Update the global 'monitors' object directly
      monitors[sheetId] = {
        red: { players: redText.split('\n').filter(Boolean) }, // Split by newline, filter out empty strings
        yellow: { players: yellowText.split('\n').filter(Boolean) },
        status: 'online',
      };
      console.log(`Successfully fetched data for sheet ${sheetId}.`);
    } catch (error) {
      console.error(`Failed to fetch data for sheet ${sheetId}:`, error);
      // Update status to error and keep existing data for this sheet if fetch fails
      monitors[sheetId] = {
        ...monitors[sheetId],
        status: 'error',
        errorMessage: error instanceof Error ? error.message : String(error),
      };
      return null;
    }
  });

  await Promise.allSettled(fetchPromises);
  // After all fetches (successful or not), update the cache
  monitorCache = {
    data: { ...monitors }, // Take a shallow copy of the current state
    timestamp: Date.now(),
  };
  console.log('Monitor data cache updated.');
}

/**
 * Attempts to update the text files on a remote monitor via SSH.
 * (This function is largely unchanged from previous steps)
 */
async function writeRemoteFile(
  sheetId: string,
  filePath: string,
  content: string,
): Promise<void> {
  const config = monitorConfigs[sheetId];
  if (!config) {
    return Promise.reject(new Error(`No SSH configuration found for sheet: ${sheetId}`));
  }

  const conn = new Client();
  const connectConfig: ConnectConfig = {
    host: config.host,
    port: config.port,
    username: config.username,
    readyTimeout: SSH_TIMEOUT_MS,
  };

  if (process.env.SSH_PRIVATE_KEY_PATH) {
    try {
      connectConfig.privateKey = fs.readFileSync(
        process.env.SSH_PRIVATE_KEY_PATH,
      );
    } catch (error) {
      return Promise.reject(new Error(`Failed to load SSH private key: ${error}`));
    }
  } else if (process.env.SSH_PASSWORD) {
    connectConfig.password = process.env.SSH_PASSWORD;
  } else {
    return Promise.reject(new Error('SSH authentication method not configured'));
  }

  return new Promise<void>((resolve, reject) => {
    conn
      .on('ready', () => {
        // Escape single quotes in content for shell command
        const escapedContent = content.replace(/'/g, "'\\''");
        const command = `echo '${escapedContent}' > ${filePath}`;
        conn.exec(command, (err, stream) => {
          if (err) {
            conn.end();
            return reject(new Error(`Failed to execute 'echo' command for ${filePath} on ${sheetId}: ${err}`));
          }
          stream
            .on('close', (code: number, signal: string) => {
              conn.end();
              if (code !== 0) {
                return reject(
                  new Error(
                    `'echo' command for ${filePath} on ${sheetId} exited with code ${code}`,
                  ),
                );
              }
              resolve();
            })
            .on('data', (data: Buffer) => {
              process.stdout.write(`Remote write stdout (${sheetId}): ${data}`);
            })
            .stderr.on('data', (data: Buffer) => {
              process.stderr.write(`Remote write stderr (${sheetId}): ${data}`);
            });
        });
      })
      .on('error', (err: Error) => {
        reject(new Error(`SSH connection error for sheet ${sheetId}: ${err.message}`));
      })
      .connect(connectConfig);
  });
}

// Re-structured updateRemoteMonitor to use the new writeRemoteFile
async function updateRemoteMonitor(
  sheetId: string,
  data: SheetMonitorData,
): Promise<void> {
  const redPromise = writeRemoteFile(
    sheetId,
    monitorConfigs[sheetId].redPath,
    getTextRepresentation(data.red),
  );
  const yellowPromise = writeRemoteFile(
    sheetId,
    monitorConfigs[sheetId].yellowPath,
    getTextRepresentation(data.yellow),
  );

  // Wait for both writes to complete or fail
  await Promise.all([redPromise, yellowPromise]);
}

/**
 * Retrieves the current in-memory state of all monitor data,
 * using a cache layer.
 * @returns AllMonitorsData object.
 */
export async function getAllMonitorData(): Promise<AllMonitorsData> {
  const now = Date.now();

  if (monitorCache && now - monitorCache.timestamp < CACHE_TTL_MS) {
    console.log('Returning cached monitor data.');
    return monitorCache.data;
  } else {
    console.log('Cache expired or not present. Fetching fresh data...');
    await updateMonitorsFromRemote(); // Fetch fresh data
    return monitorCache ? monitorCache.data : monitors; // Return updated cache or current 'monitors' if cache somehow failed
  }
}

/**
 * Updates the in-memory monitor data and pushes relevant changes to remote monitors.
 * @param updates A partial AllMonitorsData object containing updates.
 * @returns An object containing the current data and the status of remote updates.
 */
export async function updateMonitorDataAndRemote(
  updates: Partial<AllMonitorsData>,
): Promise<{
  currentData: AllMonitorsData;
  remoteUpdateStatus: PromiseSettledResult<void>[];
}> {
  let changesMadeLocally = false;
  const sheetsToUpdateRemotely: string[] = [];

  for (const sheetId in updates) {
    if (sheetId in monitors) {
      const sheetUpdate = updates[sheetId];

      if (typeof sheetUpdate !== 'object' || sheetUpdate === null) {
        console.warn(`Skipping invalid update for sheetId: ${sheetId}`);
        continue;
      }

      let sheetChanges = false;
      // Merge red team data if provided and actually different
      if (
        sheetUpdate.red &&
        JSON.stringify(getPlayersFromData(sheetUpdate.red)) !==
        JSON.stringify(getPlayersFromData(monitors[sheetId].red))
      ) {
        monitors[sheetId].red = sheetUpdate.red;
        changesMadeLocally = true;
        sheetChanges = true;
      }

      // Merge yellow team data if provided and actually different
      if (
        sheetUpdate.yellow &&
        JSON.stringify(getPlayersFromData(sheetUpdate.yellow)) !==
        JSON.stringify(getPlayersFromData(monitors[sheetId].yellow))
      ) {
        monitors[sheetId].yellow = sheetUpdate.yellow;
        changesMadeLocally = true;
        sheetChanges = true;
      }

      // Update status if provided
      if (sheetUpdate.status) {
        monitors[sheetId].status = sheetUpdate.status;
        if (sheetUpdate.errorMessage) {
          monitors[sheetId].errorMessage = sheetUpdate.errorMessage;
        } else if (sheetUpdate.status === 'online') {
          delete monitors[sheetId].errorMessage;
        }
        changesMadeLocally = true;
        sheetChanges = true;
      }

      sheetsToUpdateRemotely.push(sheetId);
    } else {
      console.warn(`Received update for unknown sheetId: ${sheetId}`);
    }
  }

  // Create promises for remote updates only for sheets that actually changed
  const updatePromises: Promise<void>[] = sheetsToUpdateRemotely.map(
    (sheetId) => updateRemoteMonitor(sheetId, monitors[sheetId]),
  );

  // Wait for all remote updates to complete (or fail)
  const results = await Promise.allSettled(updatePromises);

  // Log outcomes of remote updates and update status accordingly
  results.forEach((result, index) => {
    const sheetId = sheetsToUpdateRemotely[index];
    if (result.status === 'fulfilled') {
      console.log(`Remote update for sheet ${sheetId} succeeded.`);
      // Update status to online if remote update succeeds
      monitors[sheetId].status = 'online';
      delete monitors[sheetId].errorMessage;
    } else {
      console.error(
        `Remote update for sheet ${sheetId} failed:`,
        result.reason,
      );
      // Update status to error if remote update fails
      monitors[sheetId].status = 'error';
      monitors[sheetId].errorMessage = result.reason instanceof Error ? result.reason.message : String(result.reason);
    }
  });

  // After a POST update, update the cache with the new data
  // This ensures that subsequent GET requests retrieve the most up-to-date information
  // without needing to fetch from remote monitors again.
  monitorCache = {
    data: { ...monitors }, // Take a shallow copy of the updated state
    timestamp: Date.now(),
  };
  console.log('Cache updated with new monitor data.');

  return {
    currentData: monitors,
    remoteUpdateStatus: results,
  };
}