// src/server.ts
import express, { Express } from "express";
import apiRoutes from "./api-routes.js";
import { db } from "./database.js";

const app: Express = express();

app.use(express.json());
app.use("/api", apiRoutes);

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

export const startServer = () => {
  const PORT = process.env.PORT || 3000;
  try {
    app.listen(PORT, () => {
      console.log(`Server is running on http://localhost:${PORT}`);
      console.log(`API endpoints:`);
      console.log(`  GET  /api/contexts - Get all contexts`);
      console.log(`  POST /api/contexts - Create a new context`);
      console.log(`  GET  /api/teams/:contextName - Get teams for a context`);
      console.log(`  PUT  /api/contexts/:contextName - Update a context`);
      console.log(`  GET  /api/teams/:contextName/:teamName - Get a specific team`);
      console.log(`  POST /api/teams - Create a new team`);
      console.log(`  PUT  /api/teams/:contextName/:teamName - Update a team`);
      console.log(`  DELETE /api/teams/:contextName/:teamName - Delete a team`);
      console.log(`  GET  /api/search?contextName=...&q=... - Search for teams`);
      console.log(`  POST /api/teams/bulk - Bulk create teams`);
      console.log(`  DELETE /api/contexts/:contextName - Delete a context`);
      console.log(`  GET  /api/health - Health check`);
    });

    // Graceful shutdown
    process.on('SIGINT', () => {
      console.log('\nShutting down gracefully...');
      db.close();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.log('\nShutting down gracefully...');
      db.close();
      process.exit(0);
    });

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

export default app;