// src/server.ts
import express from 'express';
import dotenv from 'dotenv';
import { apiRouter } from './api-routes.js';
import { updateMonitorsFromRemote } from './service.js'; // Import the new function

// Load environment variables from .env file
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

/**
 * Initializes and starts the Express server.
 */
export function startServer(): void {
  // Middleware to parse JSON request bodies
  app.use(express.json());

  // Use the API routes
  app.use('/api', apiRouter);

  // Root endpoint for service status check
  app.get('/', (req, res) => {
    res.send('Curling Club Monitor Service is running!');
  });

  app.listen(port, async () => {
    console.log(`Curling Club Monitor Service listening on port ${port}`);
    console.log(`Access GET endpoint at http://localhost:${port}/api/monitors`);
    console.log(
      `Access POST endpoint at http://localhost:${port}/api/monitors`,
    );

    // Initial pull of data from monitors when the server starts
    console.log('Performing initial data pull from monitors...');
    await updateMonitorsFromRemote();
  });
}