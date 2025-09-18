// src/index.ts
import dotenv from "dotenv";
import { startServer } from "./server.js";

// Load environment variables from .env file FIRST
dotenv.config();

console.log(process.env.PORT);

startServer();
