# Curling Team Microservice

A microservice for managing curling teams and their contexts (leagues/tournaments) with SQLite storage.

## Features

- **Team Management**: Create, read, update, and delete curling teams
- **Context Management**: Teams belong to contexts (leagues or tournaments)
- **Smart Search**: Intelligent search with relevance scoring
- **Bulk Operations**: Import multiple teams using format strings
- **SQLite Storage**: Local database with automatic schema creation

## Team Structure

Each curling team has:
- **Team Name**: Required (or auto-generated from skip's last name)
- **Players**: Lead, Second, Third, Fourth (all optional)
- **Vice**: One of the 4 players (defaults to Third)
- **Skip**: One of the 4 players (defaults to Fourth)
- **Home Club**: Optional string
- **Context**: Required - the event/league the team participates in

## Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Set environment variables**:
   ```bash
   # Required: Path to SQLite database file
   DB_PATH=./data/curling.db
   
   # Optional: Server port (defaults to 3000)
   PORT=3000
   ```

3. **Run the service**:
   ```bash
   # Development mode
   npm run dev
   
   # Production mode
   npm run build
   npm start
   ```

## API Endpoints

### Contexts

#### GET /api/contexts
Get all contexts (leagues and tournaments).

**Response**:
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "Tuesday League",
      "type": "league",
      "startDate": "2024-01-15T18:00:00Z",
      "endDate": "2024-03-15T22:00:00Z",
      "createdAt": "2024-01-01T00:00:00Z",
      "updatedAt": "2024-01-01T00:00:00Z"
    }
  ]
}
```

#### POST /api/contexts
Create a new context without any teams.

**Request Body**:
```json
{
  "name": "Autumn League",
  "type": "league",
  "startDate": "2024-09-01T18:00:00Z",
  "endDate": "2024-11-30T22:00:00Z"
}
```

Notes:
- `startDate` and `endDate` are optional; if both are provided, `startDate` must be <= `endDate`.
- You may also use `contextName`, `contextType`, `contextStartDate`, `contextEndDate` as alternative keys.
- `type` must be `league`, `tournament`, or `miscellaneous`.

**Example**:
```bash
curl -X POST http://localhost:3000/api/contexts \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Autumn League",
    "type": "league"
  }'
```

#### PUT /api/contexts/:contextName
Update context name, type, or dates.

**Request Body** (all optional):
```json
{
  "name": "Autumn League - Division A",
  "type": "league",
  "startDate": "2024-09-01T18:00:00Z",
  "endDate": "2024-12-01T22:00:00Z"
}
```

Rules:
- `startDate` and `endDate` are optional; if both provided, `startDate` must be <= `endDate`.
- If changing `name`, it must be unique.
- `type` must be `league`, `tournament`, or `miscellaneous` if provided.

**Example**:
```bash
curl -X PUT "http://localhost:3000/api/contexts/Autumn%20League" \
  -H "Content-Type: application/json" \
  -d '{
    "endDate": "2024-12-01T22:00:00Z"
  }'
```

#### DELETE /api/contexts/:contextName
Delete a context. Associated teams will also be deleted (cascade).

**Example**:
```bash
curl -X DELETE "http://localhost:3000/api/contexts/Autumn%20League"
```

### Teams

#### GET /api/teams/:contextName
Get all teams for a specific context.

**Example**: `GET /api/teams/Tuesday%20League`

#### GET /api/teams/:contextName/:teamName
Get a specific team.

**Example**: `GET /api/teams/Tuesday%20League/Team%20Smith`

#### POST /api/teams
Create a new team.

Notes:
- `contextName` and `contextType` are required.
- Context dates are optional in this request; if provided, both must form a valid range.

**Request Body**:
```json
{
  "teamName": "Team Smith",
  "contextName": "Tuesday League",
  "contextType": "league",
  "contextStartDate": "2024-01-15T18:00:00Z",
  "contextEndDate": "2024-03-15T22:00:00Z",
  "lead": "John Doe",
  "second": "Jane Smith",
  "third": "Bob Johnson",
  "fourth": "Alice Brown",
  "vicePosition": "third",
  "skipPosition": "fourth",
  "homeClub": "Downtown Curling Club"
}
```

**Notes**:
- `teamName` is optional if at least one player name is provided
- If no `teamName` is provided, it will be auto-generated as "Team {skip's last name}"
- `vicePosition` defaults to "third"
- `skipPosition` defaults to "fourth"
- `vicePosition` and `skipPosition` must be different

#### PUT /api/teams/:contextName/:teamName
Update a team.

**Request Body** (all fields optional):
```json
{
  "teamName": "New Team Name",
  "lead": "New Lead Player",
  "homeClub": "New Club"
}
```

#### DELETE /api/teams/:contextName/:teamName
Delete a team.

### Search

#### GET /api/search?contextName=...&q=...
Search for teams within a context using fuzzy matching.

**Example**: `GET /api/search?contextName=Tuesday%20League&q=oreilly`

**Fuzzy Search Features**:
- **Fuzzy Matching**: Handles typos, partial matches, and variations
- **Smart Relevance**: Prioritizes matches based on field importance
- **Multi-field Search**: Searches across all team and player fields

**Search Relevance Order**:
1. Team names (highest priority)
2. Skip's last name
3. Skip's first name
4. Any player name
5. Home club
6. Any field containing query (lowest priority)

**Examples of Fuzzy Matching**:
- `"oreilly"` matches `"Kenneth O'Reilly"`
- `"macdonald"` matches `"Michael MacDonald"`
- `"vanderberg"` matches `"Pieter van der Berg"`
- `"ken"` matches `"Kenneth"`
- `"downtown"` matches `"Downtown Curling Club"`

**Response**:
```json
{
  "success": true,
  "data": [
    {
      "team": { /* team object */ },
      "context": { /* context object */ },
      "matchType": "skipLastName",
      "matchField": "skipLastName",
      "relevance": 90
    }
  ]
}
```

### Bulk Operations

#### POST /api/teams/bulk
Bulk create teams using a format string.

**Request Body**:
```json
{
  "format": "teamName, lead, second, third, fourth, homeClub",
  "data": [
    ["Team Alpha", "Alice Smith", "Bob Jones", "Carol White", "David Brown", "Downtown Club"],
    ["Team Beta", "Eve Wilson", "Frank Davis", "Grace Lee", "Henry Taylor", "Uptown Club"]
  ],
  "contextName": "Spring Tournament",
  "contextType": "tournament",
  "contextStartDate": "2024-04-01T09:00:00Z",
  "contextEndDate": "2024-04-03T18:00:00Z"
}
```

**Format String Fields**:
- `teamName`: Team name
- `lead`, `second`, `third`, `fourth`: Player names
- `vicePosition`, `skipPosition`: Player positions
- `homeClub`: Home curling club

## Usage Examples

### Creating a Team with Auto-generated Name

```bash
curl -X POST http://localhost:3000/api/teams \
  -H "Content-Type: application/json" \
  -d '{
    "contextName": "Tuesday League",
    "contextType": "league",
    "contextStartDate": "2024-01-15T18:00:00Z",
    "contextEndDate": "2024-03-15T22:00:00Z",
    "lead": "John Doe",
    "second": "Jane Smith",
    "third": "Bob Johnson",
    "fourth": "Alice Brown",
    "homeClub": "Downtown Curling Club"
  }'
```

This will create a team named "Team Brown" (from Alice Brown's last name).

### Searching for Teams

```bash
# Basic search
curl "http://localhost:3000/api/search?contextName=Tuesday%20League&q=smith"

# Fuzzy search examples
curl "http://localhost:3000/api/search?contextName=Tuesday%20League&q=oreilly"
curl "http://localhost:3000/api/search?contextName=Tuesday%20League&q=macdonald"
curl "http://localhost:3000/api/search?contextName=Tuesday%20League&q=ken"
```

### Testing Fuzzy Search

```bash
# Test the fuzzy search functionality
node tests/test-fuzzy-search.js
```

### Bulk Import from CSV-like Data

```bash
curl -X POST http://localhost:3000/api/teams/bulk \
  -H "Content-Type: application/json" \
  -d '{
    "format": "teamName, lead, second, third, fourth, homeClub",
    "data": [
      ["Team Alpha", "Alice Smith", "Bob Jones", "Carol White", "David Brown", "Downtown Club"],
      ["Team Beta", "Eve Wilson", "Frank Davis", "Grace Lee", "Henry Taylor", "Uptown Club"]
    ],
    "contextName": "Spring Tournament",
    "contextType": "tournament",
    "contextStartDate": "2024-04-01T09:00:00Z",
    "contextEndDate": "2024-04-03T18:00:00Z"
  }'
```

## Database Schema

The service automatically creates the following tables:

### contexts
- `id` (PRIMARY KEY)
- `name` (UNIQUE)
- `type` (league/tournament)
- `start_date`
- `end_date`
- `created_at`
- `updated_at`

### teams
- `id` (PRIMARY KEY)
- `team_name`
- `context_id` (FOREIGN KEY)
- `lead`, `second`, `third`, `fourth`
- `vice_position`
- `skip_position`
- `home_club`
- `created_at`
- `updated_at`
- UNIQUE(team_name, context_id)

## Error Handling

All API endpoints return consistent error responses:

```json
{
  "success": false,
  "error": "Error message describing what went wrong"
}
```

Common error scenarios:
- Missing required fields
- Invalid vice/skip positions (must be different)
- Team not found
- Context not found
- Database connection issues

## Development

### Scripts
- `npm run setup`: Initialize project (creates data directory and .env file)
- `npm run dev`: Start development server with hot reload
- `npm run build`: Build TypeScript to JavaScript
- `npm start`: Start production server
- `npm run lint`: Run ESLint
- `npm run lint:fix`: Fix ESLint issues
- `npm run test`: Run API tests
- `npm run clear-db`: Clear all data from the database

### Environment Variables
- `DB_PATH`: Path to SQLite database file (required)
- `PORT`: Server port (default: 3000)

### Database Management

The service uses SQLite for data storage. The database file is automatically created when the server starts.

**Clear Database:**
```bash
npm run clear-db
```

This will:
- Drop all existing tables and data
- Tables will be automatically recreated when the server restarts
- Useful for development and testing

**Database Location:**
- Default: `./data/curling.db` (as specified in .env)
- Can be changed by modifying the `DB_PATH` environment variable

## License

MIT License - see LICENSE file for details.
