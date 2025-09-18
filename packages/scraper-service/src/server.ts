// src/server.ts
import express, { Express } from "express";
import apiRoutes from "./api-routes.js";

const app: Express = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use("/api", apiRoutes);

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

export const startServer = () => {
  app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    console.log(`API endpoints:`);
    console.log(`  http://localhost:${PORT}/api/team?teamName=Team%20Alpha&leagueName=Monday%20Night`);
    console.log(`  http://localhost:${PORT}/api/team?teamId=101`);
    console.log(`  http://localhost:${PORT}/api/teams`);
    console.log(`  http://localhost:${PORT}/api/games`);
    console.log(`  http://localhost:${PORT}/api/nextGames`); // New default
    console.log(`  http://localhost:${PORT}/api/nextGames?count=5&fromDate=2025-07-20T12:00:00Z`); // Example with params
  });
};

export default app;