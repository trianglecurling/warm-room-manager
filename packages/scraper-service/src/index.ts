// src/index.ts
import dotenv from "dotenv";
import { startServer } from "./server.js";
import { initializeCache } from "./ccm-adapter.js";
import { closeBrowser } from "./ccm-scraper.js"; // Import closeBrowser

// Load environment variables from .env file FIRST
dotenv.config();

// Initialize the cache BEFORE starting the server
initializeCache()
  .then(() => {
    console.log("Cache initialization complete. Starting server...");
    startServer();
  })
  .catch((error) => {
    console.error("Failed to initialize cache, server will not start:", error);
    closeBrowser(); // Ensure browser is closed on initialization failure
    process.exit(1); // Exit if cache cannot be initialized
  });
