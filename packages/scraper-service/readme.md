# Curling Club Manager Scraper Microservice

This microservice provides a public RESTish API for fetching team and game data from a Curling Club Manager admin area. Since CCM does not expose a public API, this service scrapes the necessary data using Playwright and implements a robust caching layer for performance and resilience.

## AI Use

The majority of this project was vibe-coded using Gemini 2.5 Flash.

## Table of Contents

-   [Features](#features)
-   [Prerequisites](#prerequisites)
-   [Installation](#installation)
-   [Configuration](#configuration)
-   [Running the Application](#running-the-application)
    -   [Development Mode](#development-mode)
    -   [Production Mode](#production-mode)
-   [API Endpoints](#api-endpoints)
    -   [Common Query Parameter: `refreshCache`](#common-query-parameter-refreshcache)
    -   [`GET /api/teams`](#get-apiteams)
    -   [`GET /api/team`](#get-apiteam)
    -   [`GET /api/games`](#get-apigames)
    -   [`GET /api/nextGames`](#get-apinextgames)
-   [Project Structure](#project-structure)
-   [Caching Strategy](#caching-strategy)
-   [Playwright Scraping Details](#playwright-scraping-details)
-   [Error Handling](#error-handling)
-   [Contributing](#contributing)
-   [License](#license)

---

## Features

*   **RESTish API:** Exposes endpoints for teams, single team lookup, all games, and upcoming games by sheet.
*   **Data Scraping:** Uses Playwright to extract data from the Curling Club Manager (CCM) web interface.
*   **Persistent Caching:** Stores scraped data to local JSON files (`cache/`) to persist across application restarts.
*   **In-Memory Caching:** Maintains a quick-access in-memory cache to reduce file I/O for frequent requests.
*   **Scheduled Refresh:** Periodically scrapes for new data (once per day) to keep the cache fresh.
*   **On-Demand Refresh:** Supports manual cache refresh via an API query parameter.
*   **Concurrent Scraping:** Utilizes Playwright's `BrowserContext` to manage authenticated sessions and limit concurrent page loads for efficient scraping.
*   **Robust Data Processing:** Handles common scraping challenges like parsing dates, cleaning team names, and linking related entities (Games to Teams).

## Prerequisites

Before you begin, ensure you have the following installed:

*   **Node.js:** (LTS version recommended, e.g., 18.x or 20.x)
*   **npm:** (Comes with Node.js)
*   **Playwright Browsers:** Playwright automatically downloads necessary browser binaries, but you can manually install them if needed:
    ```bash
    npx playwright install
    ```

## Installation

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/your-username/curling-club-microservice.git
    cd curling-club-microservice
    ```
2.  **Install dependencies:**
    ```bash
    npm install
    ```

## Configuration

This project uses environment variables for sensitive data (like CCM login credentials) and configurable settings (like the server port).

1.  **Create a `.env` file:**
    In the root directory of your project, create a file named `.env`.

2.  **Add environment variables:**
    Populate the `.env` file with the following:

    ```env
    # Server Port
    PORT=3000

    # Curling Club Manager (CCM) Login Credentials
    # These are required for the scraper to authenticate with the /administrator panel.
    CCM_USER=your_ccm_username
    CCM_PASS=your_ccm_password
    
    # Maximum number of browser tabs to use for scraping
    MAX_CONCURRENCY=5
    BASE_URL=https://yourcurlingclub.com
    SHEET_NAMES=A,B,C,D
    ```

3.  **Git Ignore:** The `.env` file is already added to `.gitignore` to prevent it from being committed to version control.

## Running the Application

### Development Mode

For development with live reloading:

```bash
npm run dev
```

This will:
*   Start the server using `nodemon` and `tsx`.
*   Watch for changes in the `src/` directory.
*   Automatically restart the server when TypeScript files are modified.
*   Trigger an initial cache scrape upon startup (if no `cache/` files exist).
*   Schedule periodic background refreshes.

You will see console logs related to Playwright operations (login, scraping progress) and cache status.

### Production Mode

To build and run the compiled JavaScript:

```bash
npm run build
npm start
```

*   `npm run build`: Compiles all TypeScript files from `src/` into JavaScript in the `dist/` directory.
*   `npm start`: Runs the compiled application from `dist/index.js`.

---

## API Endpoints

The API is exposed on `http://localhost:<PORT>/api/`. Replace `<PORT>` with the port configured in your `.env` file (default `3000`).

### Common Query Parameter: `refreshCache`

Many `GET` endpoints can accept a `refreshCache=true` query parameter. If present, it will trigger an immediate full cache refresh before serving the request. This is useful for development or when you suspect the cached data might be stale.

Example: `http://localhost:3000/api/teams?refreshCache=true`

---

### `GET /api/teams`

Returns an array of all known teams from the cached data.

**Response:**
```json
[
  {
    "teamId": 101,
    "name": "Team Alpha",
    "league": "Monday Night",
    "skip": { "first": "John", "last": "Doe" },
    "vice": { "first": "Jane", "last": "Smith" },
    "second": { "first": "Peter", "last": "Jones" },
    "lead": { "first": "Mary", "last": "Brown" }
  },
  // ... more teams
]
```

---

### `GET /api/team`

Retrieves a single team by either its name and league, or by its unique ID.

**Query Parameters:**

*   **By Name & League:**
    *   `teamName` (string, required if `teamId` is not provided)
    *   `leagueName` (string, required if `teamName` is provided)
*   **By ID:**
    *   `teamId` (number, alternative to `teamName` and `leagueName`)

**Response (200 OK):**
A `Team` object if found, otherwise `null` (404 Not Found).

Example (by name): `http://localhost:3000/api/team?teamName=Team%20Alpha&leagueName=Monday%20Night`
Example (by ID): `http://localhost:3000/api/team?teamId=101`

---

### `GET /api/games`

Returns an array of all known games from the cached data.

**Response:**
```json
[
  {
    "date": "2025-07-22T20:30:00.000Z",
    "league": "Wednesday League",
    "sheet": "Sheet 2",
    "team1": {
      "teamId": 103,
      "name": "Team Gamma",
      "league": "Wednesday League",
      "skip": { "first": "Eve", "last": "Blue" },
      "vice": { "first": "Frank", "last": "Yellow" },
      "second": { "first": "Grace", "last": "Orange" },
      "lead": { "first": "Harry", "last": "Purple" }
    },
    "team2": {
      "teamId": 104,
      "name": "Team Delta",
      "league": "Wednesday League",
      "skip": { "first": "Ivy", "last": "Black" },
      "vice": { "first": "Jack", "last": "White" },
      "second": { "first": "Karen", "last": "Brown" },
      "lead": { "first": "Liam", "last": "Green" }
    }
  },
  // ... more games
]
```

---

### `GET /api/nextGames`

Returns the next `N` upcoming games for each sheet, optionally starting from a specified date. Sheets with no upcoming games will have an empty array.

**Query Parameters:**

*   `count` (integer, optional): The maximum number of upcoming games to return per sheet. Defaults to `3`.
*   `fromDate` (string, optional, date-time format): The date string (e.g., `YYYY-MM-DDTHH:mm:ssZ`) from which to start searching for upcoming games. Defaults to `now minus 45 minutes` (to catch recently started or ongoing games).

**Response:**
```json
{
  "Sheet 1": [
    { /* game 1 on Sheet 1 */ },
    { /* game 2 on Sheet 1 */ }
  ],
  "Sheet 2": [
    { /* game 1 on Sheet 2 */ }
  ],
  "Sheet 3": [], // Empty array if no upcoming games on this sheet
  "Sheet 4": [
    { /* game 1 on Sheet 4 */ },
    { /* game 2 on Sheet 4 */ },
    { /* game 3 on Sheet 4 */ }
  ]
}
```

Example (default): `http://localhost:3000/api/nextGames`
Example (next 5 games from specific date): `http://localhost:3000/api/nextGames?count=5&fromDate=2025-07-20T12:00:00Z`

---

## Project Structure

The project follows a modular structure to keep concerns separated:

```text
.
+-- src/                                   # Source code directory
¦   +-- api-routes.ts                      # Defines Express API endpoints and their logic
¦   +-- ccm-adapter.ts                     # Handles caching, background refresh, and interfaces with scraper
¦   +-- ccm-scraper.ts                     # Contains Playwright logic for scraping CCM website
¦   +-- index.ts                           # Application entry point, initializes cache and starts server
¦   +-- server.ts                          # Express server setup and listener
¦   +-- types.d.ts                         # TypeScript interface definitions (Team, Game, Name)
+-- .env                                   # Environment variables (IGNORED by Git)
+-- .gitignore                             # Specifies files/directories to ignore in Git
+-- package.json                           # Project metadata and dependencies
+-- tsconfig.json                          # TypeScript compiler configuration
+-- dist/                                  # Compiled JavaScript output (generated by `npm run build`)
+-- cache/                                 # Persistent cache files (teams.json, games.json) (IGNORED by Git)
```

## Caching Strategy

The microservice employs a multi-level caching strategy to optimize performance and ensure data freshness:

1.  **File System Cache (`cache/teams.json`, `cache/games.json`):**
    *   Stores the last scraped data to ensure persistence across application restarts.
    *   Loaded into memory upon `initializeCache()` when the application starts.

2.  **In-Memory Cache:**
    *   Provides rapid access for API requests, minimizing disk I/O.
    *   Data is considered "stale" after 1 hour (`CACHE_STALE_THRESHOLD_MS`). If an API request finds the in-memory cache stale, it attempts to reload from the persistent file cache.

3.  **Background Refresh:**
    *   The `refreshCache()` function is executed periodically (once per day, configurable via `REFRESH_INTERVAL_MS`) by a scheduled timer (`startBackgroundRefreshTimer`).
    *   It scrapes the latest data from the CCM website, updates the in-memory cache, and then saves the fresh data to the file system.

4.  **On-Demand Refresh (`refreshCache=true`):**
    *   Clients can explicitly request an immediate full cache refresh by adding a `refreshCache=true` query parameter to any API `GET` endpoint. This is useful for development or when an immediate data update is required.

This layered strategy ensures that data is fresh enough for users while minimizing the load on the external CCM website.

## Playwright Scraping Details

The `ccm-scraper.ts` module orchestrates the web scraping using Playwright:

*   **Login:** The scraper first authenticates with `yourcurlingclub.com/administrator` using credentials provided via `CCM_USER` and `CCM_PASS` environment variables.
*   **Shared Context:** A single Playwright `BrowserContext` is established after successful login. All subsequent parallel scraping operations create new pages (tabs) *within this same context*. This is crucial for maintaining authentication cookies and ensuring the session persists across multiple concurrent requests to the website.
*   **Team Scraping (`getAllTeams`):**
    1.  Navigates to the main teams list page.
    2.  Identifies all available league IDs from a `<select>` dropdown.
    3.  For each discovered league, it navigates to that specific league's teams list page.
    4.  Extracts individual `teamId`s from the displayed table.
    5.  For each `teamId`, a *new page* is opened within the shared browser context to visit the team's dedicated edit/detail page (`editTeam`).
    6.  Concurrently processes up to `MAX_CONCURRENT_PAGES` (default 5) team detail pages at once, significantly speeding up data collection.
    7.  Extracts team name, league association, and individual player names (Skip, Vice, Second, Lead).
    8.  Player names (e.g., "Last, First") are parsed into structured `{ first: string, last: string }` objects.
*   **Game Scraping (`getAllGames`):**
    1.  Re-uses the initial league ID discovery step.
    2.  For each league, a *new page* is opened within the shared browser context to navigate to that league's games list page (`games`).
    3.  The process concurrently scrapes game data for up to `MAX_CONCURRENT_PAGES` (default 5) league game pages.
    4.  For each game row found in the HTML table, it extracts the raw date string, sheet name, and a "Team1 VS. Team2" string.
    5.  **Team Name Cleaning:** Before linking, team names are cleaned to remove any parenthetical chores or descriptions (e.g., "Sebastian (Snack Duty)" becomes "Sebastian").
    6.  **Team Linking:** Crucially, `Game` objects are linked to the canonical `Team` objects (retrieved during the `getAllTeams` phase) by constructing a composite lookup key (e.g., "monday night::team alpha") using both the team's cleaned name and its league. This ensures accurate association even if team names are not globally unique.
    7.  Game dates are parsed from the "MM-DD-YYYY H:MM XM" format into `Date` objects.
*   **Graceful Shutdown:** `process.once` event listeners are implemented to ensure that the Playwright browser instance is reliably closed and resources are released when the Node.js process exits (e.g., via `Ctrl+C`, `SIGINT`, or `SIGTERM` signals).

## Error Handling

The microservice incorporates several layers of error handling:

*   **Playwright Failures:** Scraping functions (`getAllTeams`, `getAllGames`) use `try...catch` blocks to gracefully handle potential issues like network errors, unresponsive pages, or changes in HTML selectors. Errors are logged to the console, and the scraping process attempts to continue, returning partial data or empty arrays/`null` for individual failures, preventing the entire refresh process from crashing.
*   **Cache Initialization Errors:** If the `initializeCache()` process encounters a critical error during application startup (e.g., unable to log in to CCM), the application will log the error and terminate (`process.exit(1)`) to prevent serving stale or incomplete data.
*   **API Input Validation:** API endpoints validate incoming query parameters (`count`, `fromDate`, `teamId`). Invalid input triggers an HTTP 400 Bad Request response with an empty response body.
*   **Cache Refresh Failures:** If a manual (`refreshCache=true`) or scheduled cache refresh fails, appropriate HTTP 500 Internal Server Error responses are returned, and detailed errors are logged.
*   **Data Invariant Checks:** During game data processing in `ccm-adapter.ts`, checks are performed to warn if team leagues referenced by a game do not match the game's league, or if a team cannot be found for a game, helping to identify potential data inconsistencies.

## Contributing

Feel free to open issues, suggest improvements, or submit pull requests.

## License

MIT