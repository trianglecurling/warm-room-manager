// API client for external service
const API_BASE_URL = '';

// External base for teams/contexts
const EXTERNAL_BASE_URL = 'http://localhost:3012';
const CCM_BASE_URL = 'http://localhost:3010';
const MONITORS_BASE_URL = 'http://localhost:3011';
const ORCHESTRATOR_BASE_URL = 'http://localhost:3014';

export interface HealthResponse {
  status: string;
  message: string;
  timestamp: string;
}

export interface HelloResponse {
  message: string;
  data: {
    serverTime: string;
    environment: string;
  };
}

export interface Context {
  id: number;
  name: string;
  type?: string;
  startDate?: string;
  endDate?: string;
}

export interface CreateContextInput {
  name: string;
  type?: 'league' | 'tournament' | 'miscellaneous';
  startDate?: string;
  endDate?: string;
}

export interface UpdateContextInput {
  name?: string;
  type?: 'league' | 'tournament' | 'miscellaneous';
  startDate?: string;
  endDate?: string;
}

export interface SearchResult {
  id: number;
  name: string; // Team display name
  teamData: string; // Multiline roster text for textarea
  homeClub?: string; // Optional team home club
  skipPosition?: PlayerPosition;
  vicePosition?: PlayerPosition;
}

export interface SearchResponse {
  results: SearchResult[];
}

export interface PresetData {
  A: { red: string; yellow: string };
  B: { red: string; yellow: string };
  C: { red: string; yellow: string };
  D: { red: string; yellow: string };
  editModes?: Record<string, { teamName: string } | null>;
  teamOrigins?: Partial<Record<string, { red?: Team; yellow?: Team }>>;
}

export interface Preset {
  id: number;
  contextName: string;
  name: string;
  data: PresetData;
  createdAt: string;
  updatedAt: string;
}

export type PlayerPosition = 'lead' | 'second' | 'third' | 'fourth';

export interface CreateTeamRequest {
  teamName: string;
  contextName: string;
  contextType: 'league' | 'tournament' | 'miscellaneous';
  contextStartDate?: string;
  contextEndDate?: string;
  lead?: string;
  second?: string;
  third?: string;
  fourth?: string;
  vicePosition: PlayerPosition;
  skipPosition: PlayerPosition;
  homeClub?: string;
}

export interface CCMTeam {
  teamName: string;
  leagueName: string;
  players?: Array<{ name: string } | string>;
  homeClub?: string;
}

export interface CcmPerson { first: string; last: string }
export interface CcmGameTeam { teamId: number; name: string; league: string; skip?: CcmPerson; vice?: CcmPerson; second?: CcmPerson; lead?: CcmPerson }
export interface CcmNextGame { date: string; league: string; sheet: string; team1: CcmGameTeam; team2: CcmGameTeam }
export interface CcmNextGamesResponse { A: CcmNextGame[]; B: CcmNextGame[]; C: CcmNextGame[]; D: CcmNextGame[] }

export interface MonitorsSide { players: string[] }
export interface MonitorsSheet { red: MonitorsSide; yellow: MonitorsSide; status: string; errorMessage?: string }
export type MonitorsResponse = { A?: MonitorsSheet; B?: MonitorsSheet; C?: MonitorsSheet; D?: MonitorsSheet } & Record<string, MonitorsSheet | undefined>;

export interface TeamText { players: string[] }
// Monitor payload now supports sending either full Team objects or plain text arrays
export interface SheetMonitorData { red: Team | TeamText; yellow: Team | TeamText; status: 'online' | 'error'; errorMessage?: string }
export interface AllMonitorsData { [sheetId: string]: SheetMonitorData }

// Extended monitors data (assumption per updated monitor service)
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

export interface RichMonitorsSide extends MonitorsSide { text?: string[]; team?: Team }
export interface RichMonitorsSheet { red: RichMonitorsSide; yellow: RichMonitorsSide; status: string; errorMessage?: string }
export type RichMonitorsResponse = { A?: RichMonitorsSheet; B?: RichMonitorsSheet; C?: RichMonitorsSheet; D?: RichMonitorsSheet } & Record<string, RichMonitorsSheet | undefined>;

// Orchestrator types
export type AgentStatus = 'OFFLINE' | 'IDLE' | 'RESERVED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'ERROR' | 'DRAINING';
export type JobStatus = 'CREATED' | 'PENDING' | 'ASSIGNED' | 'ACCEPTED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'STOPPED' | 'FAILED' | 'CANCELED' | 'UNKNOWN' | 'DISMISSED';

export interface StreamMetadata {
  title?: string;
  description?: string;
  viewers?: number;
  publicUrl?: string;
  adminUrl?: string;
  isMuted?: boolean;
  streamId?: string;
  platform?: string; // e.g., "youtube", "twitch", etc.
}

export interface OrchestratorAgent {
  id: string;
  name: string;
  state: AgentStatus;
  currentJobId: string | null;
  lastSeenAt: string;
  drain: boolean;
  capabilities: {
    slots: number;
    maxResolution?: string;
  };
  meta?: Record<string, unknown>;
}

export interface OrchestratorJob {
  id: string;
  templateId?: string | null;
  inlineConfig?: Record<string, unknown> | null;
  status: JobStatus;
  agentId?: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  endedAt?: string | null;
  error?: { code: string; message: string; detail?: unknown } | null;
  requestedBy: string;
  idempotencyKey?: string;
  restartPolicy?: 'never' | 'onFailure';
  streamMetadata?: StreamMetadata;
}

export interface CreateJobRequest {
  templateId?: string;
  inlineConfig?: any;
  idempotencyKey: string;
  restartPolicy?: string;
}

export interface OrchestratorHealth {
  status: string;
  timestamp: string;
  version?: string;
}

export interface WebSocketMessage {
  type: string;
  payload: any;
  timestamp?: string;
}

// OAuth types
export type OAuthTokenStatus = 'missing' | 'valid' | 'expired';
export interface OAuthStatus {
  configured: boolean;
  tokenStatus: OAuthTokenStatus;
  isValid: boolean;
  hasClientId: boolean;
  hasClientSecret: boolean;
  hasRefreshToken: boolean;
}

class ApiClient {
  private async request<T = any>(endpoint: string, options?: RequestInit): Promise<T> {
    const url = `${API_BASE_URL}${endpoint}`;
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
      ...options,
    });

    if (!response.ok) {
      const message = await response.text().catch(() => '');
      throw new Error(message || `API request failed: ${response.status} ${response.statusText}`);
    }

    // Some endpoints may return no content
    if (response.status === 204) return {} as T;

    return response.json();
  }

  // Curling Club Manager (CCM) API
  async getCcmTeams(refreshCache = false): Promise<CCMTeam[]> {
    const url = `${CCM_BASE_URL}/api/teams${refreshCache ? '?refreshCache=true' : ''}`;
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) throw new Error(await res.text().catch(() => 'Failed to fetch CCM teams'));
    const data = await res.json();
    return Array.isArray(data) ? (data as CCMTeam[]) : Array.isArray((data as any)?.data) ? (data as any).data : [];
  }

  async getCcmNextGames(): Promise<CcmNextGamesResponse> {
    const url = `${CCM_BASE_URL}/api/nextGames`;
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) throw new Error(await res.text().catch(() => 'Failed to fetch CCM next games'));
    const data = (await res.json()) || {};
    return {
      A: Array.isArray(data.A) ? data.A : [],
      B: Array.isArray(data.B) ? data.B : [],
      C: Array.isArray(data.C) ? data.C : [],
      D: Array.isArray(data.D) ? data.D : [],
    } as CcmNextGamesResponse;
  }

  // Monitors API
  async getMonitors(): Promise<MonitorsResponse> {
    const url = `${MONITORS_BASE_URL}/api/monitors`;
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) throw new Error(await res.text().catch(() => 'Failed to fetch monitors'));
    const data = await res.json();
    return (data || {}) as MonitorsResponse;
  }

  async getMonitorsRich(): Promise<RichMonitorsResponse> {
    const url = `${MONITORS_BASE_URL}/api/monitors`;
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) throw new Error(await res.text().catch(() => 'Failed to fetch monitors'));
    const data = await res.json();
    return (data || {}) as RichMonitorsResponse;
  }

  async postMonitors(data: AllMonitorsData): Promise<void> {
    const url = `${MONITORS_BASE_URL}/api/monitors`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(await res.text().catch(() => 'Failed to send updates to monitors'));
  }

  async getHealth(): Promise<HealthResponse> {
    return this.request<HealthResponse>('/api/health');
  }

  async getHello(): Promise<HelloResponse> {
    return this.request<HelloResponse>('/api/hello');
  }

  // Contexts are from external API
  async getContexts(): Promise<Context[]> {
    const res = await fetch(`${EXTERNAL_BASE_URL}/api/contexts`);
    if (!res.ok) throw new Error(`Failed to load contexts: ${res.statusText}`);
    const raw: any = await res.json();
    const list: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : [];
    return list.map((c: any) => ({
      id: Number(c.id),
      name: String(c.name),
      type: c.type,
      startDate: c.startDate || c.start_date || undefined,
      endDate: c.endDate || c.end_date || undefined,
    }));
  }

  async createContext(input: CreateContextInput): Promise<Context> {
    const body = JSON.stringify(input);
    const res = await fetch(`${EXTERNAL_BASE_URL}/api/contexts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (!res.ok) throw new Error(await res.text().catch(() => 'Failed to create context'));
    const c = (await res.json())?.data;
    return {
      id: Number(c.id),
      name: String(c.name),
      type: c.type,
      startDate: c.startDate || c.start_date || undefined,
      endDate: c.endDate || c.end_date || undefined,
    };
  }

  async updateContext(contextName: string, input: UpdateContextInput): Promise<Context> {
    const body = JSON.stringify(input);
    const res = await fetch(`${EXTERNAL_BASE_URL}/api/contexts/${encodeURIComponent(contextName)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
    if (!res.ok) throw new Error(await res.text().catch(() => 'Failed to update context'));
    const c = (await res.json())?.data;
    return {
      id: Number(c.id),
      name: String(c.name),
      type: c.type,
      startDate: c.startDate || c.start_date || undefined,
      endDate: c.endDate || c.end_date || undefined,
    };
  }

  async deleteContext(contextName: string): Promise<void> {
    const res = await fetch(`${EXTERNAL_BASE_URL}/api/contexts/${encodeURIComponent(contextName)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await res.text().catch(() => 'Failed to delete context'));
  }

  async search(contextName: string, query: string): Promise<SearchResponse> {
    const params = new URLSearchParams({ contextName, q: query });
    const res = await fetch(`${EXTERNAL_BASE_URL}/api/search?${params}`);
    if (!res.ok) throw new Error(await res.text().catch(() => 'Search failed'));
    const raw: any = await res.json();
    // Expected: { success: true, data: [ { team: {...}, context: {...}, ... } ] }
    const items: any[] = Array.isArray(raw?.data) ? raw.data : [];

    const results: SearchResult[] = items.map((item: any) => {
      const team = item?.team ?? {};
      const name: string = team.teamName || team.name || `Team ${team.id ?? ''}`;
      const lines: string[] = [];
      if (team.lead) lines.push(team.lead);
      if (team.second) lines.push(team.second);
      if (team.third) lines.push(team.third);
      if (team.fourth) lines.push(team.fourth);
      const teamData = lines.join('\n');
      const skipPosition = (team.skipPosition || team.skip_position) as PlayerPosition | undefined;
      const vicePosition = (team.vicePosition || team.vice_position) as PlayerPosition | undefined;
      return {
        id: Number(team.id ?? Math.random()),
        name,
        teamData,
        homeClub: team.homeClub || undefined,
        skipPosition,
        vicePosition,
      };
    });

    return { results };
  }

  // Presets (local server)
  async listPresets(contextName: string): Promise<Preset[]> {
    const params = new URLSearchParams({ contextName });
    const raw = await this.request<any>(`/api/presets?${params}`);
    const list: any[] = Array.isArray(raw?.data) ? raw.data : [];
    return list.map((p: any) => ({
      id: Number(p.id),
      contextName: String(p.contextName),
      name: String(p.name),
      data: p.data as PresetData,
      createdAt: String(p.createdAt),
      updatedAt: String(p.updatedAt),
    }));
  }

  async savePreset(contextName: string, name: string, data: PresetData): Promise<Preset> {
    const body = JSON.stringify({ contextName, name, data });
    const raw = await this.request<any>('/api/presets', { method: 'POST', body });
    const p = raw?.data ?? raw;
    return {
      id: Number(p.id),
      contextName: String(p.contextName),
      name: String(p.name),
      data: p.data as PresetData,
      createdAt: String(p.createdAt),
      updatedAt: String(p.updatedAt),
    };
  }

  async deletePreset(contextName: string, name: string): Promise<void> {
    const params = new URLSearchParams({ contextName, name });
    await this.request<void>(`/api/presets?${params}`, { method: 'DELETE' });
  }

  // Teams (external API)
  async createTeam(input: CreateTeamRequest): Promise<void> {
    const url = `${EXTERNAL_BASE_URL}/api/teams`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => '');
      throw new Error(msg || `Failed to create team: ${res.status} ${res.statusText}`);
    }
  }

  async updateTeam(contextName: string, teamName: string, input: CreateTeamRequest): Promise<void> {
    const url = `${EXTERNAL_BASE_URL}/api/teams/${encodeURIComponent(contextName)}/${encodeURIComponent(teamName)}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => '');
      throw new Error(msg || `Failed to update team: ${res.status} ${res.statusText}`);
    }
  }

  async deleteTeam(contextName: string, teamName: string): Promise<void> {
    const url = `${EXTERNAL_BASE_URL}/api/teams/${encodeURIComponent(contextName)}/${encodeURIComponent(teamName)}`;
    const res = await fetch(url, { method: 'DELETE' });
    if (!res.ok) {
      const msg = await res.text().catch(() => '');
      throw new Error(msg || `Failed to delete team: ${res.status} ${res.statusText}`);
    }
  }

  // Orchestrator API methods
  async getOrchestratorHealth(): Promise<OrchestratorHealth> {
    const url = `${ORCHESTRATOR_BASE_URL}/healthz`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Orchestrator health check failed: ${res.status} ${res.statusText}`);
    return res.json();
  }

  async getAgents(): Promise<OrchestratorAgent[]> {
    const url = `${ORCHESTRATOR_BASE_URL}/v1/agents`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch agents: ${res.status} ${res.statusText}`);
    return res.json();
  }

  async getJobs(): Promise<OrchestratorJob[]> {
    const url = `${ORCHESTRATOR_BASE_URL}/v1/jobs`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch jobs: ${res.status} ${res.statusText}`);
    return res.json();
  }

  async createJob(jobRequest: CreateJobRequest): Promise<OrchestratorJob> {
    console.log(`🌐 API createJob called`, {
      idempotencyKey: jobRequest.idempotencyKey,
      streamKey: jobRequest.inlineConfig?.streamKey,
      timestamp: new Date().toISOString()
    });

    const url = `${ORCHESTRATOR_BASE_URL}/v1/jobs`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(jobRequest),
    });

    console.log(`🌐 API createJob response`, {
      status: res.status,
      statusText: res.statusText,
      idempotencyKey: jobRequest.idempotencyKey
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      console.error(`🌐 API createJob failed`, {
        status: res.status,
        errorText,
        idempotencyKey: jobRequest.idempotencyKey
      });
      throw new Error(errorText || `Failed to create job: ${res.status} ${res.statusText}`);
    }
    const result = await res.json();
    console.log(`🌐 API createJob success`, {
      jobId: result.id,
      idempotencyKey: jobRequest.idempotencyKey
    });
    return result;
  }

  async stopJob(jobId: string): Promise<void> {
    const url = `${ORCHESTRATOR_BASE_URL}/v1/jobs/${jobId}/stop`;
    const res = await fetch(url, { method: 'POST' });
    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      throw new Error(errorText || `Failed to stop job: ${res.status} ${res.statusText}`);
    }
  }

  async setAgentDrain(agentId: string, drain: boolean): Promise<void> {
    const url = `${ORCHESTRATOR_BASE_URL}/v1/agents/${agentId}/drain`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ drain }),
    });
    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      throw new Error(errorText || `Failed to set agent drain mode: ${res.status} ${res.statusText}`);
    }
  }

  async rebootAgent(agentId: string, reason?: string): Promise<{ ok: boolean; message: string; method?: string; host?: string }> {
    const url = `${ORCHESTRATOR_BASE_URL}/v1/agents/${agentId}/reboot`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      const errorData = await res.json().catch(() => ({ error: errorText }));
      throw new Error(errorData.error || errorData.message || `Failed to reboot agent: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  async updateAgentMeta(agentId: string, meta: Record<string, unknown>): Promise<{ ok: boolean; agent: OrchestratorAgent }> {
    const url = `${ORCHESTRATOR_BASE_URL}/v1/agents/${agentId}/meta`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meta }),
    });
    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      throw new Error(errorText || `Failed to update agent metadata: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  // Stream metadata management
  async getJobMetadata(jobId: string): Promise<{ metadata: StreamMetadata }> {
    const url = `${ORCHESTRATOR_BASE_URL}/v1/jobs/${jobId}/metadata`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to get job metadata: ${res.status} ${res.statusText}`);
    return res.json();
  }

  async updateJobMetadata(jobId: string, metadata: Partial<StreamMetadata>): Promise<{ ok: boolean; metadata: StreamMetadata }> {
    const url = `${ORCHESTRATOR_BASE_URL}/v1/jobs/${jobId}/metadata`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata),
    });
    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      throw new Error(errorText || `Failed to update job metadata: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  // Audio control
  async muteJob(jobId: string): Promise<{ ok: boolean; job: OrchestratorJob }> {
    const url = `${ORCHESTRATOR_BASE_URL}/v1/jobs/${jobId}/mute`;
    const res = await fetch(url, { method: 'POST' });
    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      throw new Error(errorText || `Failed to mute job: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  async unmuteJob(jobId: string): Promise<{ ok: boolean; job: OrchestratorJob }> {
    const url = `${ORCHESTRATOR_BASE_URL}/v1/jobs/${jobId}/unmute`;
    const res = await fetch(url, { method: 'POST' });
    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      throw new Error(errorText || `Failed to unmute job: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  async dismissJob(jobId: string): Promise<{ ok: boolean; job: OrchestratorJob }> {
    const url = `${ORCHESTRATOR_BASE_URL}/v1/jobs/${jobId}/dismiss`;
    const res = await fetch(url, { method: 'POST' });
    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      throw new Error(errorText || `Failed to dismiss job: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  // WebSocket connection for real-time updates
  createOrchestratorWebSocket(): WebSocket {
    const wsUrl = `ws://${ORCHESTRATOR_BASE_URL.replace('http://', '')}/ui`;
    return new WebSocket(wsUrl);
  }

  // OAuth endpoints (orchestrator)
  async getOAuthStatus(): Promise<OAuthStatus> {
    const url = `${ORCHESTRATOR_BASE_URL}/oauth/status`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to get OAuth status: ${res.status} ${res.statusText}`);
    return res.json();
  }

  async getOAuthAuthUrl(): Promise<{ authUrl: string }> {
    const url = `${ORCHESTRATOR_BASE_URL}/oauth/auth-url`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to get OAuth auth URL: ${res.status} ${res.statusText}`);
    return res.json();
  }

  async exchangeOAuthCode(code: string): Promise<{ success: boolean; message?: string; refreshToken?: string }> {
    const url = `${ORCHESTRATOR_BASE_URL}/oauth/token`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) throw new Error(await res.text().catch(() => 'Failed to exchange OAuth code'));
    return res.json();
  }

  async clearOAuthToken(): Promise<{ success: boolean; message?: string }> {
    const url = `${ORCHESTRATOR_BASE_URL}/oauth/token`;
    const res = await fetch(url, { method: 'DELETE' });
    if (!res.ok) throw new Error(await res.text().catch(() => 'Failed to clear OAuth token'));
    return res.json();
  }

  async updateStreamPrivacy(privacy: 'public' | 'unlisted'): Promise<{ success: boolean; privacy: string }> {
    const url = `${ORCHESTRATOR_BASE_URL}/v1/config/stream-privacy`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ privacy })
    });
    if (!res.ok) throw new Error(await res.text().catch(() => 'Failed to update stream privacy'));
    return res.json();
  }

  async getAlternateColors(): Promise<{ alternateColors: boolean }> {
    const url = `${ORCHESTRATOR_BASE_URL}/v1/config/alternate-colors`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(await res.text().catch(() => 'Failed to get alternate colors setting'));
    return res.json();
  }

  async updateAlternateColors(alternateColors: boolean): Promise<{ success: boolean; alternateColors: boolean }> {
    const url = `${ORCHESTRATOR_BASE_URL}/v1/config/alternate-colors`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alternateColors })
    });
    if (!res.ok) throw new Error(await res.text().catch(() => 'Failed to update alternate colors'));
    return res.json();
  }

  // Team names management
  async updateTeamNames(sheet: string, red?: string, yellow?: string): Promise<{ success: boolean; teamNames: { red: string; yellow: string } }> {
    const url = `${ORCHESTRATOR_BASE_URL}/v1/teamnames`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheet, red, yellow })
    });
    if (!res.ok) throw new Error(await res.text().catch(() => 'Failed to update team names'));
    return res.json();
  }
}

export const apiClient = new ApiClient(); 