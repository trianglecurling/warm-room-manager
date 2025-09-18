export interface GameSpec {
    team1Name: string;
    team2Name: string;
    date: Date;
}

export interface Game {
    date: Date;
    league: string;
    sheet: string;
    team1: Team;
    team2: Team;
}

export interface Team {
    teamId: number;
    name: string;
    league: string;
    skip: Name;
    vice: Name;
    second: Name;
    lead: Name;
}

export interface Name {
    first: string;
    last: string;
}