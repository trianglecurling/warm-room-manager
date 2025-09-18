import express from 'express';
import cors from 'cors';
import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { dbQueries, PresetRow } from './db.js';

// Load environment variables
config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3013;

// Middleware
app.use(cors());
app.use(express.json());

// API Routes
app.get('/api/health', (_req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Server is running!',
    timestamp: new Date().toISOString()
  });
});

// Timer control endpoint - provides admin password for timer operations
app.get('/api/timer-admin-password', (_req, res) => {
  const adminPassword = process.env.EOTC_ADMIN_PW;
  if (!adminPassword) {
    return res.status(500).json({ error: 'Admin password not configured' });
  }
  res.json({ password: adminPassword });
});

app.get('/api/hello', (_req, res) => {
  res.json({ 
    message: 'Hello from the backend!',
    data: {
      serverTime: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development'
    }
  });
});

// Presets endpoints (no server-side contexts)
app.get('/api/presets', (req, res) => {
  const contextName = String(req.query.contextName || '');
  if (!contextName) return res.status(400).json({ error: 'contextName is required' });
  const rows = dbQueries.listPresetsByContext(contextName);
  type Row = { id: number; context_name: string; name: string; data_json: string; created_at: string; updated_at: string };
  res.json({ data: (rows as Row[]).map((r: Row) => ({ id: r.id, contextName: r.context_name, name: r.name, data: JSON.parse(r.data_json), createdAt: r.created_at, updatedAt: r.updated_at })) });
});

app.post('/api/presets', (req, res) => {
  const { contextName, name, data } = req.body || {};
  if (!contextName || !name || !data) return res.status(400).json({ error: 'contextName, name and data are required' });
  const inserted = dbQueries.insertOrUpdatePreset({ context_name: String(contextName), name: String(name), data_json: JSON.stringify(data) }) as PresetRow;
  res.status(201).json({ data: { id: inserted.id, contextName: inserted.context_name, name: inserted.name, data: JSON.parse(inserted.data_json), createdAt: inserted.created_at, updatedAt: inserted.updated_at } });
});

app.delete('/api/presets', (req, res) => {
  const contextName = String(req.query.contextName || '');
  const name = String(req.query.name || '');
  if (!contextName || !name) return res.status(400).json({ error: 'contextName and name are required' });
  const info = dbQueries.deletePreset(contextName, name);
  if (info.changes === 0) return res.status(404).json({ error: 'Preset not found' });
  res.status(204).send();
});

// Serve static files from the client build directory
app.use(express.static(path.join(__dirname, '../../dist/client')));

// Catch all handler: send back React's index.html file for any non-API routes
app.get('*', (req, res) => {
  // Don't serve index.html for API routes
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint not found' });
  }
  
  res.sendFile(path.join(__dirname, '../../dist/client/index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📁 Environment: ${process.env.NODE_ENV || 'development'}`);
}); 