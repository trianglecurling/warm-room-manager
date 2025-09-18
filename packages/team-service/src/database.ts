import Database from 'better-sqlite3';
import Fuse, { FuseResultMatch } from 'fuse.js';
import { Team, Context, TeamCreateRequest, TeamUpdateRequest, SearchResult } from './types.js';

export class DatabaseManager {
  private db: Database.Database;

  constructor() {
    const dbPath = process.env.DB_PATH;
    if (!dbPath) {
      throw new Error('DB_PATH environment variable is required');
    }
    
    try {
      this.db = new Database(dbPath);
      this.initializeTables();
    } catch (error) {
      throw new Error(`Failed to initialize database at ${dbPath}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private initializeTables() {
    // Create contexts table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contexts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK(type IN ('league', 'tournament', 'miscellaneous')),
        start_date TEXT,
        end_date TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // If contexts table exists but doesn't include 'miscellaneous' in CHECK, migrate it
    try {
      const row = this.db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='contexts'`).get() as { sql?: string } | undefined;
      const createSql = row?.sql || '';
      if (createSql && !createSql.includes("'miscellaneous'")) {
        // Migrate table to include new CHECK option
        this.db.pragma('foreign_keys = OFF');
        this.db.exec('BEGIN');
        try {
          // Create new table with desired schema
          this.db.exec(`
            CREATE TABLE contexts_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL UNIQUE,
              type TEXT NOT NULL CHECK(type IN ('league', 'tournament', 'miscellaneous')),
              start_date TEXT,
              end_date TEXT,
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
          `);
          // Copy data
          this.db.exec(`
            INSERT INTO contexts_new (id, name, type, start_date, end_date, created_at, updated_at)
            SELECT id, name, type, start_date, end_date, created_at, updated_at FROM contexts;
          `);
          // Replace old table
          this.db.exec('DROP TABLE contexts');
          this.db.exec('ALTER TABLE contexts_new RENAME TO contexts');
          // Recreate indexes
          this.db.exec(`CREATE INDEX IF NOT EXISTS idx_contexts_name ON contexts(name);`);
          this.db.exec('COMMIT');
        } catch (e) {
          this.db.exec('ROLLBACK');
          throw e;
        } finally {
          this.db.pragma('foreign_keys = ON');
        }
      }
    } catch (e) {
      // If inspection or migration fails, rethrow to surface meaningful error
      throw e;
    }

    // Create teams table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS teams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_name TEXT NOT NULL,
        context_id INTEGER NOT NULL,
        lead TEXT,
        second TEXT,
        third TEXT,
        fourth TEXT,
        vice_position TEXT NOT NULL CHECK(vice_position IN ('lead', 'second', 'third', 'fourth')),
        skip_position TEXT NOT NULL CHECK(skip_position IN ('lead', 'second', 'third', 'fourth')),
        home_club TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (context_id) REFERENCES contexts(id) ON DELETE CASCADE,
        UNIQUE(team_name, context_id)
      )
    `);

    // Create indexes for better search performance
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_teams_context_id ON teams(context_id);
      CREATE INDEX IF NOT EXISTS idx_teams_team_name ON teams(team_name);
      CREATE INDEX IF NOT EXISTS idx_contexts_name ON contexts(name);
    `);
  }

  // Context operations
  getContexts(): Context[] {
    const stmt = this.db.prepare('SELECT * FROM contexts ORDER BY name');
    return stmt.all() as Context[];
  }

  getContextByName(name: string): Context | undefined {
    const stmt = this.db.prepare('SELECT * FROM contexts WHERE name = ?');
    return stmt.get(name) as Context | undefined;
  }

  createContext(name: string, type: 'league' | 'tournament' | 'miscellaneous', startDate?: string, endDate?: string): Context {
    const stmt = this.db.prepare(`
      INSERT INTO contexts (name, type, start_date, end_date)
      VALUES (?, ?, ?, ?)
    `);
    const result = stmt.run(name, type, startDate ?? null, endDate ?? null);
    
    return this.getContextByName(name)!;
  }

  updateContext(currentName: string, updates: { name?: string; type?: 'league' | 'tournament' | 'miscellaneous'; startDate?: string; endDate?: string; }): Context {
    const ctx = this.getContextByName(currentName);
    if (!ctx) {
      throw new Error('Context not found');
    }

    const fields: string[] = [];
    const values: any[] = [];

    if (updates.name !== undefined && updates.name !== ctx.name) {
      // Ensure new name is not taken
      const existing = this.getContextByName(updates.name);
      if (existing) {
        throw new Error('Another context with this name already exists');
      }
      fields.push('name = ?');
      values.push(updates.name);
    }
    if (updates.type !== undefined) {
      fields.push('type = ?');
      values.push(updates.type);
    }
    if (updates.startDate !== undefined) {
      fields.push('start_date = ?');
      values.push(updates.startDate);
    }
    if (updates.endDate !== undefined) {
      fields.push('end_date = ?');
      values.push(updates.endDate);
    }

    if (fields.length === 0) {
      return ctx; // nothing to update
    }

    fields.push("updated_at = datetime('now')");

    const stmt = this.db.prepare(`
      UPDATE contexts
      SET ${fields.join(', ')}
      WHERE name = ?
    `);
    values.push(currentName);
    stmt.run(...values);

    // If name changed, fetch by new name
    const newName = updates.name || currentName;
    return this.getContextByName(newName)!;
  }

  deleteContext(name: string): boolean {
    const stmt = this.db.prepare('DELETE FROM contexts WHERE name = ?');
    const result = stmt.run(name);
    return result.changes > 0;
  }

  // Team operations
  getTeamsByContext(contextName: string): (Team & { context: Context })[] {
    const stmt = this.db.prepare(`
      SELECT t.*, c.* 
      FROM teams t 
      JOIN contexts c ON t.context_id = c.id 
      WHERE c.name = ?
      ORDER BY t.team_name
    `);
    const rows = stmt.all(contextName) as any[];
    
    return rows.map(row => ({
      id: row.id,
      teamName: row.team_name,
      contextId: row.context_id,
      lead: row.lead,
      second: row.second,
      third: row.third,
      fourth: row.fourth,
      vicePosition: row.vice_position,
      skipPosition: row.skip_position,
      homeClub: row.home_club,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      context: {
        id: row.id,
        name: row.name,
        type: row.type,
        startDate: row.start_date,
        endDate: row.end_date,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }
    })) as any;
  }

  getTeam(teamName: string, contextName: string): (Team & { context: Context }) | undefined {
    const stmt = this.db.prepare(`
      SELECT t.*, c.* 
      FROM teams t 
      JOIN contexts c ON t.context_id = c.id 
      WHERE t.team_name = ? AND c.name = ?
    `);
    const row = stmt.get(teamName, contextName) as any;
    
    if (!row) return undefined;
    
    return {
      id: row.id,
      teamName: row.team_name,
      contextId: row.context_id,
      lead: row.lead,
      second: row.second,
      third: row.third,
      fourth: row.fourth,
      vicePosition: row.vice_position,
      skipPosition: row.skip_position,
      homeClub: row.home_club,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      context: {
        id: row.context_id,
        name: row.name,
        type: row.type,
        startDate: row.start_date,
        endDate: row.end_date,
        createdAt: row.context_created_at,
        updatedAt: row.context_updated_at
      }
    };
  }

  createTeam(request: TeamCreateRequest): Team {
    // Get or create context
    let context = this.getContextByName(request.contextName);
    if (!context) {
      context = this.createContext(
        request.contextName,
        request.contextType,
        request.contextStartDate,
        request.contextEndDate
      );
    }

    // Generate team name if not provided
    let teamName = request.teamName;
    if (!teamName) {
      const skipName = this.getPlayerName(request, request.skipPosition || 'fourth');
      if (skipName) {
        const lastName = skipName.split(' ').pop() || 'Unknown';
        teamName = `Team ${lastName}`;
      } else {
        throw new Error('Team name is required when no player names are provided');
      }
    }

    // Set default vice and skip positions
    const vicePosition = request.vicePosition || 'third';
    const skipPosition = request.skipPosition || 'fourth';

    // Validate that vice and skip are different
    if (vicePosition === skipPosition) {
      throw new Error('Vice and skip positions must be different');
    }

    const stmt = this.db.prepare(`
      INSERT INTO teams (
        team_name, context_id, lead, second, third, fourth, 
        vice_position, skip_position, home_club
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      teamName,
      context.id,
      request.lead,
      request.second,
      request.third,
      request.fourth,
      vicePosition,
      skipPosition,
      request.homeClub
    );

    return this.getTeam(teamName, request.contextName)!;
  }

  updateTeam(teamName: string, contextName: string, updates: TeamUpdateRequest): Team {
    const team = this.getTeam(teamName, contextName);
    if (!team) {
      throw new Error('Team not found');
    }

    // Validate vice and skip positions if both are being updated
    if (updates.vicePosition && updates.skipPosition && updates.vicePosition === updates.skipPosition) {
      throw new Error('Vice and skip positions must be different');
    }

    const updateFields: string[] = [];
    const values: any[] = [];

    if (updates.teamName !== undefined) {
      updateFields.push('team_name = ?');
      values.push(updates.teamName);
    }
    if (updates.lead !== undefined) {
      updateFields.push('lead = ?');
      values.push(updates.lead);
    }
    if (updates.second !== undefined) {
      updateFields.push('second = ?');
      values.push(updates.second);
    }
    if (updates.third !== undefined) {
      updateFields.push('third = ?');
      values.push(updates.third);
    }
    if (updates.fourth !== undefined) {
      updateFields.push('fourth = ?');
      values.push(updates.fourth);
    }
    if (updates.vicePosition !== undefined) {
      updateFields.push('vice_position = ?');
      values.push(updates.vicePosition);
    }
    if (updates.skipPosition !== undefined) {
      updateFields.push('skip_position = ?');
      values.push(updates.skipPosition);
    }
    if (updates.homeClub !== undefined) {
      updateFields.push('home_club = ?');
      values.push(updates.homeClub);
    }

    updateFields.push('updated_at = datetime(\'now\')');

    const stmt = this.db.prepare(`
      UPDATE teams 
      SET ${updateFields.join(', ')}
      WHERE team_name = ? AND context_id = ?
    `);

    values.push(teamName, team.contextId);
    stmt.run(...values);

    const newTeamName = updates.teamName || teamName;
    return this.getTeam(newTeamName, contextName)!;
  }

  deleteTeam(teamName: string, contextName: string): boolean {
    const team = this.getTeam(teamName, contextName);
    if (!team) {
      return false;
    }

    const stmt = this.db.prepare('DELETE FROM teams WHERE team_name = ? AND context_id = ?');
    const result = stmt.run(teamName, team.contextId);
    
    return result.changes > 0;
  }

  searchTeams(contextName: string, query: string): SearchResult[] {
    const context = this.getContextByName(contextName);
    if (!context) {
      return [];
    }

    // Get all teams for the context
    const stmt = this.db.prepare(`
      SELECT 
        t.*,
        c.name as context_name,
        c.type as context_type,
        c.start_date,
        c.end_date,
        c.created_at as context_created_at,
        c.updated_at as context_updated_at
      FROM teams t
      JOIN contexts c ON t.context_id = c.id
      WHERE c.name = ?
      ORDER BY t.team_name
    `);

    const rows = stmt.all(contextName) as any[];
    
    if (rows.length === 0) {
      return [];
    }

    // Transform rows to team objects with searchable fields
    const searchableTeams = rows.map(row => {
      const team: Team = {
        id: row.id,
        teamName: row.team_name,
        contextId: row.context_id,
        lead: row.lead,
        second: row.second,
        third: row.third,
        fourth: row.fourth,
        vicePosition: row.vice_position,
        skipPosition: row.skip_position,
        homeClub: row.home_club,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };

      const context: Context = {
        id: row.context_id,
        name: row.context_name,
        type: row.context_type,
        startDate: row.start_date,
        endDate: row.end_date,
        createdAt: row.context_created_at,
        updatedAt: row.context_updated_at
      };

      // Create searchable fields for fuzzy matching
      const searchableFields = this.createSearchableFields(team);
      
      return {
        team,
        context,
        searchableFields
      };
    });

    // Configure Fuse.js for fuzzy search
    const fuseOptions = {
      keys: [
        { name: 'searchableFields.teamName', weight: 1.0 },
        { name: 'searchableFields.skipLastName', weight: 0.9 },
        { name: 'searchableFields.skipFirstName', weight: 0.85 },
        { name: 'searchableFields.playerNames', weight: 0.8 },
        { name: 'searchableFields.homeClub', weight: 0.7 },
        { name: 'searchableFields.allFields', weight: 0.5 },
        // Normalized keys to match punctuation-insensitive queries like "oreilly"
        { name: 'searchableFields.teamNameNormalized', weight: 1.0 },
        { name: 'searchableFields.skipLastNameNormalized', weight: 0.9 },
        { name: 'searchableFields.skipFirstNameNormalized', weight: 0.85 },
        { name: 'searchableFields.playerNamesNormalized', weight: 0.8 },
        { name: 'searchableFields.homeClubNormalized', weight: 0.7 },
        { name: 'searchableFields.allFieldsNormalized', weight: 0.5 }
      ],
      threshold: 0.3,
      includeScore: true,
      includeMatches: true,
      minMatchCharLength: 1,
      ignoreLocation: true,
      useExtendedSearch: false
    };

    const fuse = new Fuse(searchableTeams, fuseOptions);
    const searchResults = fuse.search(query);

    // Transform results to SearchResult format
    const results: SearchResult[] = searchResults.map(result => {
      const { team, context, searchableFields } = result.item;
      const score = result.score || 1;
      
      // Convert Fuse.js score (0 = perfect match, 1 = no match) to our relevance score (100 = perfect match, 0 = no match)
      const relevance = Math.round((1 - score) * 100);
      
      // Determine match type based on which field matched
      const matchInfo = this.determineMatchType(result.matches || [], searchableFields);
      
      return {
        team,
        context,
        ...matchInfo,
        relevance
      };
    });

    // Sort by relevance (highest first)
    return results.sort((a, b) => b.relevance - a.relevance);
  }

  private createSearchableFields(team: Team) {
    const normalize = (value?: string) => (value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    const skipName = this.getPlayerName(team, team.skipPosition);
    const skipParts = skipName ? skipName.split(' ') : [];
    const skipLastName = skipParts[skipParts.length - 1] || '';
    const skipFirstName = skipParts[0] || '';

    const playerNames = [
      team.lead,
      team.second,
      team.third,
      team.fourth
    ].filter(Boolean).join(' ');

    const allFields = [
      team.teamName,
      team.lead,
      team.second,
      team.third,
      team.fourth,
      team.homeClub
    ].filter(Boolean).join(' ');

    return {
      teamName: team.teamName,
      skipLastName,
      skipFirstName,
      playerNames,
      homeClub: team.homeClub || '',
      allFields,
      // Normalized variants to improve fuzzy matching across punctuation and casing
      teamNameNormalized: normalize(team.teamName),
      skipLastNameNormalized: normalize(skipLastName),
      skipFirstNameNormalized: normalize(skipFirstName),
      playerNamesNormalized: normalize(playerNames),
      homeClubNormalized: normalize(team.homeClub),
      allFieldsNormalized: normalize(allFields)
    };
  }

  private determineMatchType(matches: readonly FuseResultMatch[], searchableFields: any): { matchType: SearchResult['matchType'], matchField: string } {
    // Find the highest priority match
    const matchPriorities = [
      { key: 'teamName', type: 'teamName' as const },
      { key: 'teamNameNormalized', type: 'teamName' as const },
      { key: 'skipLastName', type: 'skipLastName' as const },
      { key: 'skipLastNameNormalized', type: 'skipLastName' as const },
      { key: 'skipFirstName', type: 'skipFirstName' as const },
      { key: 'skipFirstNameNormalized', type: 'skipFirstName' as const },
      { key: 'playerNames', type: 'playerName' as const },
      { key: 'playerNamesNormalized', type: 'playerName' as const },
      { key: 'homeClub', type: 'homeClub' as const },
      { key: 'homeClubNormalized', type: 'homeClub' as const },
      { key: 'allFields', type: 'contains' as const },
      { key: 'allFieldsNormalized', type: 'contains' as const }
    ];

    for (const { key, type } of matchPriorities) {
      const match = matches.find(m => m.key === key);
      if (match) {
        return {
          matchType: type,
          matchField: key
        };
      }
    }

    // Fallback
    return {
      matchType: 'contains',
      matchField: 'allFields'
    };
  }



  private getPlayerName(team: Team | TeamCreateRequest, position: 'lead' | 'second' | 'third' | 'fourth'): string | undefined {
    switch (position) {
      case 'lead': return team.lead;
      case 'second': return team.second;
      case 'third': return team.third;
      case 'fourth': return team.fourth;
      default: return undefined;
    }
  }

  // Bulk operations
  bulkCreateTeams(format: string, data: string[][], contextName: string, contextType: 'league' | 'tournament' | 'miscellaneous', contextStartDate: string, contextEndDate: string): Team[] {
    const teams: Team[] = [];
    
    // Get or create context
    let context = this.getContextByName(contextName);
    if (!context) {
      context = this.createContext(contextName, contextType, contextStartDate, contextEndDate);
    }

    // Parse format string to understand column mapping
    const formatParts = format.split(',').map(part => part.trim());
    
    for (const row of data) {
      if (row.length !== formatParts.length) {
        throw new Error(`Row length ${row.length} doesn't match format length ${formatParts.length}`);
      }

      const teamData: any = {};
      for (let i = 0; i < formatParts.length; i++) {
        teamData[formatParts[i]] = row[i];
      }

      const teamRequest: TeamCreateRequest = {
        teamName: teamData.teamName,
        contextName,
        contextType,
        contextStartDate,
        contextEndDate,
        lead: teamData.lead,
        second: teamData.second,
        third: teamData.third,
        fourth: teamData.fourth,
        vicePosition: teamData.vicePosition,
        skipPosition: teamData.skipPosition,
        homeClub: teamData.homeClub
      };

      const team = this.createTeam(teamRequest);
      teams.push(team);
    }

    return teams;
  }

  close() {
    this.db.close();
  }
}

// Export singleton instance with lazy initialization
let dbInstance: DatabaseManager | null = null;

export const db = {
  get instance(): DatabaseManager {
    if (!dbInstance) {
      dbInstance = new DatabaseManager();
    }
    return dbInstance;
  },
  
  // Proxy all methods to the instance
  getContexts: () => db.instance.getContexts(),
  getContextByName: (name: string) => db.instance.getContextByName(name),
  createContext: (name: string, type: 'league' | 'tournament' | 'miscellaneous', startDate?: string, endDate?: string) => db.instance.createContext(name, type, startDate, endDate),
  updateContext: (currentName: string, updates: { name?: string; type?: 'league' | 'tournament' | 'miscellaneous'; startDate?: string; endDate?: string; }) => db.instance.updateContext(currentName, updates),
  deleteContext: (name: string) => db.instance.deleteContext(name),
  getTeamsByContext: (contextName: string) => db.instance.getTeamsByContext(contextName),
  getTeam: (teamName: string, contextName: string) => db.instance.getTeam(teamName, contextName),
  createTeam: (request: TeamCreateRequest) => db.instance.createTeam(request),
  updateTeam: (teamName: string, contextName: string, updates: TeamUpdateRequest) => db.instance.updateTeam(teamName, contextName, updates),
  deleteTeam: (teamName: string, contextName: string) => db.instance.deleteTeam(teamName, contextName),
  searchTeams: (contextName: string, query: string) => db.instance.searchTeams(contextName, query),
  bulkCreateTeams: (format: string, data: string[][], contextName: string, contextType: 'league' | 'tournament' | 'miscellaneous', contextStartDate: string, contextEndDate: string) => db.instance.bulkCreateTeams(format, data, contextName, contextType, contextStartDate, contextEndDate),
  close: () => {
    if (dbInstance) {
      dbInstance.close();
      dbInstance = null;
    }
  }
}; 