export interface Player {
  name: string;
  position: 'lead' | 'second' | 'third' | 'fourth';
  isVice: boolean;
  isSkip: boolean;
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

export interface TeamCreateRequest {
  teamName?: string;
  contextName: string;
  contextType: 'league' | 'tournament' | 'miscellaneous';
  contextStartDate?: string;
  contextEndDate?: string;
  lead?: string;
  second?: string;
  third?: string;
  fourth?: string;
  vicePosition?: 'lead' | 'second' | 'third' | 'fourth';
  skipPosition?: 'lead' | 'second' | 'third' | 'fourth';
  homeClub?: string;
}

export interface TeamUpdateRequest {
  teamName?: string;
  lead?: string;
  second?: string;
  third?: string;
  fourth?: string;
  vicePosition?: 'lead' | 'second' | 'third' | 'fourth';
  skipPosition?: 'lead' | 'second' | 'third' | 'fourth';
  homeClub?: string;
}

export interface Context {
  id: number;
  name: string;
  type: 'league' | 'tournament' | 'miscellaneous';
  startDate?: string;
  endDate?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SearchRequest {
  contextName: string;
  query: string;
}

export interface BulkTeamData {
  format: string;
  data: string[][];
  contextName: string;
  contextType: 'league' | 'tournament' | 'miscellaneous';
  contextStartDate?: string;
  contextEndDate?: string;
}

export interface SearchResult {
  team: Team;
  context: Context;
  matchType: 'teamName' | 'skipLastName' | 'skipFirstName' | 'playerName' | 'homeClub' | 'contains';
  matchField: string;
  relevance: number;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}
