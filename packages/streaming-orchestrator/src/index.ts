import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { WebSocketServer, WebSocket } from "ws";
import { youtubeService, YouTubeService } from "./youtube-service";
import { randomUUID } from "crypto";
import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { AgentInfo, AgentState, Job, JobStatus, WSMessage, Msg, StreamMetadata, StreamContext } from "@warm-room-manager/shared";

const execAsync = promisify(exec);

/**
 * Configuration
 */
const PORT = Number(process.env.PORT ?? 8080);
const AGENT_TOKEN = process.env.AGENT_TOKEN ?? "dev-shared-token";
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS ?? 3000);
const HEARTBEAT_TIMEOUT_MS = Number(process.env.HEARTBEAT_TIMEOUT_MS ?? 10000);
const STOP_GRACE_MS = Number(process.env.STOP_GRACE_MS ?? 10000);
const KILL_AFTER_MS = Number(process.env.KILL_AFTER_MS ?? 5000);
const STREAM_HEALTH_INTERVAL_MS = Number(process.env.STREAM_HEALTH_INTERVAL_MS ?? 15000);
const STREAM_INACTIVE_GRACE_MS = Number(process.env.STREAM_INACTIVE_GRACE_MS ?? 30000);
const STREAM_RESTART_BACKOFFS_MS = [5000, 15000, 45000];

// Security: Enable IP-based access control to restrict public access
// Set to true in production to only allow /status and /status-ws from external IPs
const ENABLE_PUBLIC_ACCESS_RESTRICTIONS = process.env.ENABLE_PUBLIC_ACCESS_RESTRICTIONS === 'true';

// In-memory stream privacy setting (not persisted)
let currentStreamPrivacy: 'public' | 'unlisted' = (process.env.YOUTUBE_STREAM_PRIVACY === 'public' ? 'public' : 'unlisted');

// In-memory alternate colors setting (not persisted)
let useAlternateColors = false;

/**
 * Security: IP-based access control helpers
 */

// List of public endpoints that can be accessed from external IPs
const PUBLIC_ENDPOINTS = new Set([
	'/',
	'/status',
	'/healthz',
]);

// List of public WebSocket paths
const PUBLIC_WS_PATHS = new Set([
	'/status-ws',
]);

/**
 * Check if an IP address is from a trusted/internal source
 * Returns true for localhost and private IP ranges
 */
function isTrustedIP(ip: string): boolean {
	// Handle IPv6 localhost
	if (ip === '::1' || ip === '::ffff:127.0.0.1') {
		return true;
	}

	// Handle IPv4 localhost
	if (ip === '127.0.0.1' || ip.startsWith('127.')) {
		return true;
	}

	// Handle private IPv4 ranges
	// 10.0.0.0/8
	if (ip.startsWith('10.')) {
		return true;
	}

	// 172.16.0.0/12
	const parts = ip.split('.');
	if (parts[0] === '172') {
		const second = parseInt(parts[1], 10);
		if (second >= 16 && second <= 31) {
			return true;
		}
	}

	// 192.168.0.0/16
	if (ip.startsWith('192.168.')) {
		return true;
	}

	// Not a trusted IP
	return false;
}

/**
 * Get the real client IP from the request
 * Handles X-Forwarded-For header set by reverse proxy
 */
function getClientIP(request: any): string {
	// Check X-Forwarded-For header (set by reverse proxy)
	const forwardedFor = request.headers['x-forwarded-for'];
	if (forwardedFor) {
		// X-Forwarded-For can be a comma-separated list, take the first one
		const ips = forwardedFor.split(',').map((ip: string) => ip.trim());
		return ips[0];
	}

	// Check X-Real-IP header (alternative header used by some proxies)
	const realIP = request.headers['x-real-ip'];
	if (realIP) {
		return realIP;
	}

	// Fallback to socket remote address
	return request.socket?.remoteAddress || request.ip || 'unknown';
}

/**
 * In-memory stores (replace with SQLite later)
 */
type AgentNode = AgentInfo & {
	ws?: WebSocket;
	remoteAddress?: string; // IP address from WebSocket connection
	timers: {
		heartbeatTimeout?: NodeJS.Timeout;
	};
};

// Debounced YouTube metadata updates
type PendingYouTubeUpdate = {
	timer: NodeJS.Timeout;
	broadcastId: string;
	updates: { title?: string; description?: string };
};
const pendingYouTubeUpdates = new Map<string, PendingYouTubeUpdate>(); // jobId -> pending update

// Team names storage for browser sources
type TeamNamesStore = {
	[sheet: string]: {
		red: string;
		yellow: string;
	};
};

const agents = new Map<string, AgentNode>();
const jobs = new Map<string, Job>();
const pendingByIdem = new Map<string, string>(); // idemKey -> jobId
const streamHealth = new Map<string, { firstInactiveAt?: number; nextRestartAt?: number; attempts: number }>();
const pendingRestarts = new Set<string>();
const teamNames: TeamNamesStore = {
	A: { red: '', yellow: '' },
	B: { red: '', yellow: '' },
	C: { red: '', yellow: '' },
	D: { red: '', yellow: '' },
	vibe: { red: '', yellow: '' },
};

// Rate limiter for YouTube broadcast creation: max 10 per 10 minutes
const broadcastTimestamps: number[] = []; // Array of timestamps (ms since epoch)

// Global job creation rate limiter: allow bursts of up to 5 jobs, then 2 seconds between requests
const recentJobCreations: number[] = []; // Timestamps of recent job creations
const BURST_ALLOWANCE = 5; // Allow up to 5 jobs without rate limiting
const MIN_TIME_BETWEEN_JOBS = 2000; // 2 seconds minimum between jobs after burst

/**
 * Check if creating a YouTube broadcast would exceed the rate limit
 * @returns true if allowed, false if rate limit exceeded
 */
function checkBroadcastRateLimit(): boolean {
	const now = Date.now();
	const tenMinutesAgo = now - (10 * 60 * 1000);

	// Remove timestamps older than 10 minutes
	while (broadcastTimestamps.length > 0 && broadcastTimestamps[0] < tenMinutesAgo) {
		broadcastTimestamps.shift();
	}

	// Check if we would exceed the limit
	return broadcastTimestamps.length < 10;
}

/**
 * Record a successful broadcast creation for rate limiting
 */
function recordBroadcastCreation(): void {
	broadcastTimestamps.push(Date.now());
}

/**
 * Check if job creation is allowed based on global rate limiting
 * @returns true if allowed, false if rate limit exceeded
 */
function checkJobCreationRateLimit(): boolean {
	const now = Date.now();

	// Clean up old timestamps (older than the minimum time window)
	const cutoffTime = now - MIN_TIME_BETWEEN_JOBS;
	while (recentJobCreations.length > 0 && recentJobCreations[0] < cutoffTime) {
		recentJobCreations.shift();
	}

	// Allow burst: if we have fewer than BURST_ALLOWANCE recent jobs, allow immediately
	if (recentJobCreations.length < BURST_ALLOWANCE) {
		return true;
	}

	// After burst allowance, check timing: must be at least MIN_TIME_BETWEEN_JOBS since oldest job
	const timeSinceOldest = now - recentJobCreations[0];
	return timeSinceOldest >= MIN_TIME_BETWEEN_JOBS;
}

/**
 * Record a job creation attempt for global rate limiting
 */
function recordJobCreation(): void {
	recentJobCreations.push(Date.now());
}

/**
 * UI WS hub
 */
const uiClients = new Set<WebSocket>();
function broadcastUI<T = unknown>(type: string, payload: T) {
	const msg: WSMessage<T> = {
		type,
		msgId: randomUUID(),
		ts: new Date().toISOString(),
		payload,
	};
	const data = JSON.stringify(msg);
	for (const ws of uiClients) {
		try {
			ws.send(data);
		} catch (_) {
			/* noop */
		}
	}
}

/**
 * Status WS hub for public status updates
 */
const statusClients = new Set<WebSocket>();

function getStatusData() {
	const activeStatuses: JobStatus[] = ["PENDING", "ASSIGNED", "ACCEPTED", "STARTING", "RUNNING", "STOPPING"];
	const activeJobs = Array.from(jobs.values()).filter(job => activeStatuses.includes(job.status));

	const streams = activeJobs.map(job => {
		const metadata = job.streamMetadata;
		const context = metadata?.streamContext;
		const youtube = metadata?.youtube;

		let thumbnail: string | undefined;
		if (youtube?.videoId) {
			thumbnail = `https://i.ytimg.com/vi/${youtube.videoId}/maxresdefault.jpg`;
		}

		return {
			sheet: context?.sheet || null,
			title: metadata?.title || null,
			description: metadata?.description || null,
			publicLink: metadata?.publicUrl || null,
			adminLink: metadata?.adminUrl || null,
			thumbnail: thumbnail || null,
			startTime: job.startedAt || job.createdAt,
			team1: (context?.sheet === 'vibe' ? null : context?.team1) || null,
			team2: (context?.sheet === 'vibe' ? null : context?.team2) || null,
		};
	});

	return { streams };
}

function broadcastStatus() {
	const statusData = getStatusData();
	const msg = JSON.stringify({
		type: 'status.update',
		ts: new Date().toISOString(),
		payload: statusData,
	});

	for (const ws of statusClients) {
		try {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(msg);
			}
		} catch (_) {
			/* noop */
		}
	}
}

/**
 * Browser source WS hub for team name updates
 */
const browserSourceClients = new Map<string, Set<WebSocket>>(); // key: "sheet:color"
function broadcastTeamNameUpdate(sheet: string, color: 'red' | 'yellow', teamName: string) {
	const key = `${sheet}:${color}`;
	const clients = browserSourceClients.get(key);
	if (!clients) return;

	const msg = JSON.stringify({
		type: 'teamname.update',
		sheet,
		color,
		teamName,
		ts: new Date().toISOString(),
	});

	for (const ws of clients) {
		try {
			ws.send(msg);
		} catch (_) {
			/* noop */
		}
	}
}

function broadcastColorModeUpdate(useAlternateColors: boolean) {
	const msg = JSON.stringify({
		type: 'colormode.update',
		useAlternateColors,
		ts: new Date().toISOString(),
	});

	// Broadcast to all browser source clients
	for (const clientSet of browserSourceClients.values()) {
		for (const ws of clientSet) {
			try {
				ws.send(msg);
			} catch (_) {
				/* noop */
			}
		}
	}
}

/**
 * Helpers
 */
function createJob(partial: Partial<Job> & { inlineConfig?: Record<string, unknown> | null }, requestedBy = "ui"): Job {
	const id = randomUUID();
	const job: Job = {
		id,
		templateId: partial.templateId ?? null,
		inlineConfig: partial.inlineConfig ?? null,
		status: partial.status ?? "PENDING", // Allow custom status
		agentId: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		startedAt: null,
		endedAt: null,
		error: null,
		requestedBy,
		idempotencyKey: partial.idempotencyKey,
		restartPolicy: partial.restartPolicy ?? "never",
	};
	jobs.set(id, job);
	broadcastUI(Msg.UIJobUpdate, job);
	broadcastStatus(); // Broadcast status update to public clients
	return job;
}

function updateJob(id: string, patch: Partial<Job>) {
	const j = jobs.get(id);
	if (!j) return;
	Object.assign(j, patch, { updatedAt: new Date().toISOString() });
	jobs.set(id, j);
	broadcastUI(Msg.UIJobUpdate, j);
	broadcastStatus(); // Broadcast status update to public clients
}

function emitJobEvent(jobId: string, type: string, message: string, data?: Record<string, unknown>) {
	broadcastUI(Msg.UIJobEvent, {
		jobId,
		type,
		message,
		data,
		ts: new Date().toISOString(),
	});
}

async function endBroadcastForJob(job: Job, reason: string) {
	const broadcastId = job.streamMetadata?.youtube?.broadcastId;
	if (!broadcastId) return;
	try {
		await youtubeService.endBroadcast(broadcastId);
		console.log(`✅ Ended YouTube broadcast for job ${job.id}. Reason: ${reason}`);
		emitJobEvent(job.id, "broadcast.completed", "YouTube broadcast completed", { reason, broadcastId });
	} catch (error) {
		console.error(`❌ Failed to end YouTube broadcast for job ${job.id}:`, error);
		emitJobEvent(job.id, "broadcast.complete_failed", "Failed to complete YouTube broadcast", {
			reason,
			broadcastId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

async function queueStreamRestart(job: Job, reason: string, details?: Record<string, unknown>) {
	if (pendingRestarts.has(job.id)) return;
	pendingRestarts.add(job.id);

	const agent = job.agentId ? agents.get(job.agentId) : null;
	if (!agent || agent.state === "OFFLINE" || !agent.ws) {
		updateJob(job.id, {
			status: "PENDING",
			agentId: null,
			startedAt: null,
			endedAt: null,
			error: null,
			streamMetadata: { ...job.streamMetadata, isPaused: false },
		});
		pendingRestarts.delete(job.id);
		emitJobEvent(job.id, "stream.restart_queued", "Stream restart queued (agent unavailable)", { reason, ...details });
		return;
	}

	const msg: WSMessage = {
		type: Msg.OrchestratorJobStop,
		msgId: randomUUID(),
		ts: new Date().toISOString(),
		payload: { jobId: job.id, reason, deadlineMs: STOP_GRACE_MS },
	};
	agent.ws.send(JSON.stringify(msg));
	updateJob(job.id, { status: "STOPPING" });
	emitJobEvent(job.id, "stream.restart_requested", "Stream restart requested", { reason, ...details });
}

function toPublicAgent(a: AgentNode): AgentInfo {
	const {
		ws: _ws,
		timers: _timers,
		...rest
	} = a as unknown as {
		ws?: WebSocket;
		timers: unknown;
	};
	return rest as AgentInfo;
}

function setAgentState(a: AgentNode, state: AgentState) {
	a.state = state;
	if (state === "OFFLINE") {
		a.currentJobId = null;
	}
	broadcastUI(Msg.UIAgentUpdate, toPublicAgent(a));
}

/**
 * Fastify HTTP server
 */
const app = Fastify({ logger: false });

// Configure CORS for development and production
async function setupApp() {
	await app.register(cors, {
		origin: process.env.NODE_ENV === 'production'
			? process.env.ALLOWED_ORIGINS?.split(',') || false
			: true, // Allow all origins in development
		credentials: true,
		methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
		allowedHeaders: ['Content-Type', 'Authorization']
	});

	// Add IP-based access control hook
	if (ENABLE_PUBLIC_ACCESS_RESTRICTIONS) {
		app.addHook('onRequest', async (request, reply) => {
			const clientIP = getClientIP(request);
			const path = request.url;
			const isTrusted = isTrustedIP(clientIP);

			// Log access attempts for monitoring
			if (!isTrusted && !PUBLIC_ENDPOINTS.has(path)) {
				console.warn(`⚠️  Blocked external access attempt from ${clientIP} to ${path}`);
			}

			// If the request is from a trusted IP, allow all endpoints
			if (isTrusted) {
				return;
			}

			// If the request is from an external IP, only allow public endpoints
			if (!PUBLIC_ENDPOINTS.has(path)) {
				console.warn(`❌ Rejected external access from ${clientIP} to non-public endpoint: ${path}`);
				return reply.code(403).send({
					error: 'Forbidden',
					message: 'This endpoint is not publicly accessible'
				});
			}

			// Log allowed public access
			console.log(`✅ Allowed public access from ${clientIP} to ${path}`);
		});

		console.log('🔒 Public access restrictions ENABLED');
		console.log(`   Public HTTP endpoints: ${Array.from(PUBLIC_ENDPOINTS).join(', ')}`);
		console.log(`   Public WS paths: ${Array.from(PUBLIC_WS_PATHS).join(', ')}`);
	} else {
		console.log('⚠️  Public access restrictions DISABLED (all endpoints accessible)');
	}
}

app.get("/healthz", async () => ({ ok: true }));

// Root endpoint - serves a live stream status monitor page
app.get("/", async (request, reply) => {
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Live Stream Status - Triangle Curling</title>
	<style>
		* {
			margin: 0;
			padding: 0;
			box-sizing: border-box;
		}
		body {
			font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
			padding: 20px;
			background: #f5f5f5;
		}
		.container {
			max-width: 1200px;
			margin: 0 auto;
			background: white;
			padding: 20px;
			border-radius: 8px;
			box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
		}
		h1 {
			color: #333;
			margin-bottom: 10px;
		}
		.status {
			display: inline-block;
			padding: 4px 12px;
			border-radius: 4px;
			font-size: 14px;
			font-weight: 600;
			margin-bottom: 20px;
		}
		.status.connected {
			background: #4caf50;
			color: white;
		}
		.status.disconnected {
			background: #f44336;
			color: white;
		}
		.status.connecting {
			background: #ff9800;
			color: white;
		}
		.streams {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
			gap: 20px;
			margin-top: 20px;
		}
		.stream-card {
			border: 1px solid #e0e0e0;
			border-radius: 8px;
			overflow: hidden;
			transition: transform 0.2s, box-shadow 0.2s;
		}
		.stream-card:hover {
			transform: translateY(-4px);
			box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
		}
		.stream-card img {
			width: 100%;
			height: 180px;
			object-fit: cover;
			background: #000;
		}
		.stream-card .content {
			padding: 15px;
		}
		.stream-card h3 {
			color: #333;
			margin-bottom: 8px;
			font-size: 16px;
		}
		.stream-card .sheet {
			display: inline-block;
			background: #2196f3;
			color: white;
			padding: 2px 8px;
			border-radius: 4px;
			font-size: 12px;
			font-weight: 600;
			margin-bottom: 8px;
		}
		.stream-card .teams {
			color: #666;
			font-size: 14px;
			margin-bottom: 8px;
		}
		.stream-card .time {
			color: #999;
			font-size: 12px;
			margin-bottom: 12px;
		}
		.stream-card .links {
			display: flex;
			gap: 10px;
		}
		.stream-card a {
			flex: 1;
			padding: 8px;
			text-align: center;
			border-radius: 4px;
			text-decoration: none;
			font-size: 14px;
			font-weight: 600;
			transition: opacity 0.2s;
		}
		.stream-card a:hover {
			opacity: 0.8;
		}
		.stream-card a.public {
			background: #4caf50;
			color: white;
		}
		.no-streams {
			text-align: center;
			padding: 40px;
			color: #999;
			font-size: 18px;
		}
	</style>
</head>
<body>
	<div class="container">
		<h1>Triangle Curling Live Stream Status</h1>
		<div class="status connecting" id="status">Connecting...</div>

		<div class="streams" id="streams">
			<div class="no-streams">Connecting to stream status server...</div>
		</div>
	</div>

	<script>
		let ws;
		let reconnectTimeout;
		const WS_URL = 'wss://stream.tccnc.club/status-ws';

		function connect() {
			const statusEl = document.getElementById('status');
			
			statusEl.textContent = 'Connecting...';
			statusEl.className = 'status connecting';

			ws = new WebSocket(WS_URL);

			ws.onopen = () => {
				console.log('WebSocket connected');
				statusEl.textContent = 'Connected';
				statusEl.className = 'status connected';
				clearTimeout(reconnectTimeout);
			};

			ws.onmessage = (event) => {
				try {
					const data = JSON.parse(event.data);
					console.log('Received status update:', data);
					
					if (data.type === 'status.update') {
						updateStreams(data.payload.streams);
					}
				} catch (error) {
					console.error('Error parsing message:', error);
				}
			};

			ws.onclose = () => {
				console.log('WebSocket disconnected');
				statusEl.textContent = 'Disconnected';
				statusEl.className = 'status disconnected';
				
				// Auto-reconnect after 2 seconds
				clearTimeout(reconnectTimeout);
				reconnectTimeout = setTimeout(connect, 2000);
			};

			ws.onerror = (error) => {
				console.error('WebSocket error:', error);
				ws.close();
			};
		}

		function updateStreams(streams) {
			const streamsEl = document.getElementById('streams');
			
			if (!streams || streams.length === 0) {
				streamsEl.innerHTML = '<div class="no-streams">No active streams</div>';
				return;
			}

			streamsEl.innerHTML = streams.map(stream => {
				const sheetLabel = stream.sheet === 'vibe' ? 'VIBE' : \`SHEET \${stream.sheet}\`;
				const teams = stream.team1 && stream.team2 
					? \`\${stream.team1} vs \${stream.team2}\`
					: '';
				
				const startTime = new Date(stream.startTime);
				const timeStr = startTime.toLocaleString();

				return \`
					<div class="stream-card">
						\${stream.thumbnail ? \`<img src="\${stream.thumbnail}" alt="Stream thumbnail" onerror="this.style.display='none'">\` : ''}
						<div class="content">
							<div class="sheet">\${sheetLabel}</div>
							<h3>\${stream.title || 'Untitled Stream'}</h3>
							\${teams ? \`<div class="teams">\${teams}</div>\` : ''}
							<div class="time">Started: \${timeStr}</div>
							<div class="links">
								\${stream.publicLink ? \`<a href="\${stream.publicLink}" target="_blank" class="public">Watch Live</a>\` : ''}
							</div>
						</div>
					</div>
				\`;
			}).join('');
		}

		// Connect on page load
		connect();
	</script>
</body>
</html>`;
	
	reply.type('text/html');
	return html;
});

// Status endpoint - returns information about all active streams
// This endpoint has open CORS to allow access from any client/origin
app.get("/status", {
	preHandler: async (request, reply) => {
		// Set CORS headers to allow any origin
		reply.header('Access-Control-Allow-Origin', '*');
		reply.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
		reply.header('Access-Control-Allow-Headers', 'Content-Type');
	}
}, async () => {
	return getStatusData();
});

// Team names management endpoints
app.get("/v1/teamnames", async () => {
	return teamNames;
});

app.put<{
	Body: {
		sheet: string;
		red?: string;
		yellow?: string;
	};
}>("/v1/teamnames", async (req, reply) => {
	const { sheet, red, yellow } = req.body;
	
	if (!sheet || !teamNames[sheet]) {
		return reply.code(400).send({ error: 'Invalid sheet identifier' });
	}

	if (red !== undefined) {
		teamNames[sheet].red = red;
		broadcastTeamNameUpdate(sheet, 'red', red);
	}

	if (yellow !== undefined) {
		teamNames[sheet].yellow = yellow;
		broadcastTeamNameUpdate(sheet, 'yellow', yellow);
	}

	return { success: true, teamNames: teamNames[sheet] };
});

// Browser source endpoint for OBS
app.get<{
	Params: {
		sheet: string;
		color: string;
	};
}>("/teamnames/:sheet/:color", async (req, reply) => {
	const { sheet, color } = req.params;
	
	if (!teamNames[sheet] || (color !== 'red' && color !== 'yellow')) {
		return reply.code(404).send({ error: 'Invalid sheet or color' });
	}

	// Vibe stream shows all 4 sheets
	const isVibeStream = sheet === 'vibe';
	
	// Determine color based on alternate colors setting
	const getColor = (colorParam: string): string => {
		if (useAlternateColors) {
			return colorParam === 'red' ? '#3B82F6' : '#10B981'; // Blue and Green
		}
		return colorParam === 'red' ? '#DC2626' : '#EAB308'; // Red and Yellow
	};
	
	let html: string;
	
	if (isVibeStream) {
		// Show all 4 team names for vibe stream
		const teamA = teamNames['A'][color as 'red' | 'yellow'];
		const teamB = teamNames['B'][color as 'red' | 'yellow'];
		const teamC = teamNames['C'][color as 'red' | 'yellow'];
		const teamD = teamNames['D'][color as 'red' | 'yellow'];
		const teamColor = getColor(color);

		html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Team Names - Vibe ${color}</title>
	<style>
		* {
			margin: 0;
			padding: 0;
			box-sizing: border-box;
		}
		body {
			font-family: 'Arial', sans-serif;
			background: transparent;
			display: flex;
			align-items: center;
			justify-content: center;
			min-height: 100vh;
			overflow: hidden;
			width: 100vw;
		}
		#team-names-container {
			display: flex;
			width: 100%;
			height: 100%;
			align-items: center;
			justify-content: space-around;
		}
		.team-name {
			font-size: 48px;
			font-weight: bold;
			text-align: center;
			text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.8);
			padding: 20px;
			width: 25%;
			transition: opacity 0.3s ease;
			color: ${teamColor};
		}
		.hidden {
			opacity: 0;
		}
	</style>
</head>
<body>
	<div id="team-names-container">
		<div class="team-name" data-sheet="A">${teamA || ''}</div>
		<div class="team-name" data-sheet="B">${teamB || ''}</div>
		<div class="team-name" data-sheet="C">${teamC || ''}</div>
		<div class="team-name" data-sheet="D">${teamD || ''}</div>
	</div>
	<script>
		const color = '${color}';
		const sheets = ['A', 'B', 'C', 'D'];
		
		// Helper to get color based on mode
		function getColor(colorParam, useAlternateColors) {
			if (useAlternateColors) {
				return colorParam === 'red' ? '#3B82F6' : '#10B981'; // Blue and Green
			}
			return colorParam === 'red' ? '#DC2626' : '#EAB308'; // Red and Yellow
		}
		
		// Update all team name colors
		function updateColors(useAlternateColors) {
			const newColor = getColor(color, useAlternateColors);
			document.querySelectorAll('.team-name').forEach(el => {
				el.style.color = newColor;
			});
		}
		
		// Connect to WebSocket for live updates
		const wsUrl = \`ws://\${window.location.host}/teamnames-ws\`;
		let ws;
		let reconnectTimeout;

		function connect() {
			ws = new WebSocket(wsUrl);
			
			ws.onopen = () => {
				console.log('WebSocket connected');
				// Register for all 4 sheets
				sheets.forEach(sheet => {
					ws.send(JSON.stringify({
						type: 'register',
						sheet: sheet,
						color: color
					}));
				});
			};
			
			ws.onmessage = (event) => {
				try {
					const data = JSON.parse(event.data);
					
					if (data.type === 'colormode.update') {
						// Update colors immediately
						updateColors(data.useAlternateColors);
					} else if (data.type === 'teamname.update' && sheets.includes(data.sheet) && data.color === color) {
						const teamNameEl = document.querySelector(\`.team-name[data-sheet="\${data.sheet}"]\`);
						if (teamNameEl) {
							// Fade out, update, fade in
							teamNameEl.classList.add('hidden');
							setTimeout(() => {
								teamNameEl.textContent = data.teamName || '';
								teamNameEl.classList.remove('hidden');
							}, 300);
						}
					}
				} catch (err) {
					console.error('Failed to parse message:', err);
				}
			};
			
			ws.onclose = () => {
				console.log('WebSocket disconnected, reconnecting in 2s...');
				clearTimeout(reconnectTimeout);
				reconnectTimeout = setTimeout(connect, 2000);
			};
			
			ws.onerror = (err) => {
				console.error('WebSocket error:', err);
				ws.close();
			};
		}
		
		connect();
	</script>
</body>
</html>`;
	} else {
		// Single sheet display
		const teamName = teamNames[sheet][color as 'red' | 'yellow'];
		const teamColor = getColor(color);

		html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Team Name - ${sheet.toUpperCase()} ${color}</title>
	<style>
		* {
			margin: 0;
			padding: 0;
			box-sizing: border-box;
		}
		body {
			font-family: 'Arial', sans-serif;
			background: transparent;
			display: flex;
			align-items: center;
			justify-content: center;
			min-height: 100vh;
			overflow: hidden;
		}
		#team-name {
			font-size: 48px;
			font-weight: bold;
			text-align: center;
			text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.8);
			padding: 20px;
			transition: opacity 0.3s ease;
			color: ${teamColor};
		}
		.hidden {
			opacity: 0;
		}
	</style>
</head>
<body>
	<div id="team-name">${teamName || ''}</div>
	<script>
		const sheet = '${sheet}';
		const color = '${color}';
		const teamNameEl = document.getElementById('team-name');
		
		// Helper to get color based on mode
		function getColor(colorParam, useAlternateColors) {
			if (useAlternateColors) {
				return colorParam === 'red' ? '#3B82F6' : '#10B981'; // Blue and Green
			}
			return colorParam === 'red' ? '#DC2626' : '#EAB308'; // Red and Yellow
		}
		
		// Update color
		function updateColor(useAlternateColors) {
			const newColor = getColor(color, useAlternateColors);
			teamNameEl.style.color = newColor;
		}
		
		// Connect to WebSocket for live updates
		const wsUrl = \`ws://\${window.location.host}/teamnames-ws\`;
		let ws;
		let reconnectTimeout;

		function connect() {
			ws = new WebSocket(wsUrl);
			
			ws.onopen = () => {
				console.log('WebSocket connected');
				// Send registration message
				ws.send(JSON.stringify({
					type: 'register',
					sheet: sheet,
					color: color
				}));
			};
			
			ws.onmessage = (event) => {
				try {
					const data = JSON.parse(event.data);
					
					if (data.type === 'colormode.update') {
						// Update color immediately
						updateColor(data.useAlternateColors);
					} else if (data.type === 'teamname.update' && data.sheet === sheet && data.color === color) {
						// Fade out, update, fade in
						teamNameEl.classList.add('hidden');
						setTimeout(() => {
							teamNameEl.textContent = data.teamName || '';
							teamNameEl.classList.remove('hidden');
						}, 300);
					}
				} catch (err) {
					console.error('Failed to parse message:', err);
				}
			};
			
			ws.onclose = () => {
				console.log('WebSocket disconnected, reconnecting in 2s...');
				clearTimeout(reconnectTimeout);
				reconnectTimeout = setTimeout(connect, 2000);
			};
			
			ws.onerror = (err) => {
				console.error('WebSocket error:', err);
				ws.close();
			};
		}
		
		connect();
	</script>
</body>
</html>`;
	}

	reply.type('text/html');
	return html;
});

// OAuth management endpoints
app.get("/oauth/status", async () => {
	const hasClientId = !!process.env.YOUTUBE_CLIENT_ID;
	const hasClientSecret = !!process.env.YOUTUBE_CLIENT_SECRET;
	const hasRefreshToken = !!process.env.YOUTUBE_REFRESH_TOKEN;

	let tokenStatus = 'missing';
	let isValid = false;

	if (hasRefreshToken) {
		try {
			// Test token validity by attempting to refresh it
			const oauth2Client = new google.auth.OAuth2(
				process.env.YOUTUBE_CLIENT_ID,
				process.env.YOUTUBE_CLIENT_SECRET
			);
			oauth2Client.setCredentials({
				refresh_token: process.env.YOUTUBE_REFRESH_TOKEN
			});

			// This will throw if token is invalid
			await oauth2Client.getAccessToken();
			tokenStatus = 'valid';
			isValid = true;
		} catch (error) {
			tokenStatus = 'expired';
			isValid = false;
		}
	}

	return {
		configured: hasClientId && hasClientSecret,
		tokenStatus,
		isValid,
		hasClientId,
		hasClientSecret,
		hasRefreshToken
	};
});

app.get("/oauth/auth-url", async () => {
	const CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
	const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;

	if (!CLIENT_ID || !CLIENT_SECRET) {
		throw new Error('YouTube OAuth2 credentials not configured');
	}

	const oauth2Client = new google.auth.OAuth2(
		CLIENT_ID,
		CLIENT_SECRET,
		'http://localhost:3014/oauth/callback' // Web redirect URI
	);

	const authUrl = oauth2Client.generateAuthUrl({
		access_type: 'offline',
		scope: [
			'https://www.googleapis.com/auth/youtube',
			'https://www.googleapis.com/auth/youtube.force-ssl',
			'https://www.googleapis.com/auth/youtube.upload'
		],
		prompt: 'consent'
	});

	return { authUrl };
});

app.post("/oauth/token", async (req) => {
	const { code } = req.body as { code: string };

	if (!code) {
		throw new Error('Authorization code is required');
	}

	const CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
	const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;

	if (!CLIENT_ID || !CLIENT_SECRET) {
		throw new Error('YouTube OAuth2 credentials not configured');
	}

	const oauth2Client = new google.auth.OAuth2(
		CLIENT_ID,
		CLIENT_SECRET,
		'http://localhost:3014/oauth/callback'
	);

	try {
		const { tokens } = await oauth2Client.getToken(code);
		oauth2Client.setCredentials(tokens);

		// Update environment variable in-memory
		if (tokens.refresh_token) {
			process.env.YOUTUBE_REFRESH_TOKEN = tokens.refresh_token;

			// Persist to .env file
			try {
				const envPath = join(process.cwd(), '.env');
				let envContent = '';
				try {
					envContent = readFileSync(envPath, 'utf8');
				} catch (e) {
					// .env doesn't exist, create new one
				}

				// Check if refresh token already exists
				const refreshTokenExists = envContent.includes('YOUTUBE_REFRESH_TOKEN=');

				if (refreshTokenExists) {
					// Replace existing refresh token
					const lines = envContent.split('\n');
					const updatedLines = lines.map(line => {
						if (line.startsWith('YOUTUBE_REFRESH_TOKEN=')) {
							return `YOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}`;
						}
						return line;
					});
					writeFileSync(envPath, updatedLines.join('\n'));
					console.log('✅ Updated YOUTUBE_REFRESH_TOKEN in .env file');
				} else {
					// Add new refresh token
					const newEnvVars = [
						`# YouTube OAuth2 Refresh Token`,
						`YOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}`,
						''
					].join('\n');

					const updatedEnv = envContent
						? envContent + '\n' + newEnvVars
						: newEnvVars;

					writeFileSync(envPath, updatedEnv);
					console.log('✅ Added YOUTUBE_REFRESH_TOKEN to .env file');
				}
			} catch (error) {
				console.warn('⚠️  Could not save refresh token to .env file:', error);
				console.warn('Token updated in memory only - restart required for persistence');
			}

			// Update the YouTubeService singleton with the new token
			youtubeService.updateRefreshToken(tokens.refresh_token);
		}

		return {
			success: true,
			message: 'OAuth2 token updated successfully',
			refreshToken: tokens.refresh_token ? 'updated' : 'not_provided'
		};
	} catch (error) {
		throw new Error(`Failed to exchange authorization code: ${error instanceof Error ? error.message : 'Unknown error'}`);
	}
});

app.delete("/oauth/token", async () => {
	// Clear the refresh token
	delete process.env.YOUTUBE_REFRESH_TOKEN;

	return { success: true, message: 'OAuth2 token cleared successfully' };
});

// Stream configuration endpoints
app.get("/v1/config/stream-privacy", async () => {
	return { privacy: currentStreamPrivacy };
});

app.put<{ Body: { privacy: 'public' | 'unlisted' } }>("/v1/config/stream-privacy", async (req, reply) => {
	const { privacy } = req.body;
	if (privacy !== 'public' && privacy !== 'unlisted') {
		return reply.code(400).send({ error: 'Invalid privacy setting. Must be "public" or "unlisted"' });
	}

	currentStreamPrivacy = privacy;

	return { success: true, privacy };
});

app.get("/v1/config/alternate-colors", async () => {
	return { alternateColors: useAlternateColors };
});

app.put<{ Body: { alternateColors: boolean } }>("/v1/config/alternate-colors", async (req, reply) => {
	const { alternateColors } = req.body;
	if (typeof alternateColors !== 'boolean') {
		return reply.code(400).send({ error: 'Invalid alternateColors setting. Must be a boolean' });
	}

	useAlternateColors = alternateColors;
	
	// Broadcast to all browser sources so they update immediately
	broadcastColorModeUpdate(alternateColors);

	return { success: true, alternateColors };
});

app.get("/oauth/callback", async (req, reply) => {
	const { code, error } = req.query as { code?: string; error?: string };

	if (error) {
		// Handle OAuth error
		return reply.redirect(`http://localhost:3013/oauth?error=${encodeURIComponent(error)}`);
	}

	if (!code) {
		return reply.redirect(`http://localhost:3013/oauth?error=no_code`);
	}

	// Redirect back to frontend with the authorization code
	return reply.redirect(`http://localhost:3013/oauth?code=${encodeURIComponent(code)}`);
});

// Agents REST
app.get("/v1/agents", async () => {
	return Array.from(agents.values()).map(toPublicAgent);
});

app.post<{
	Params: { id: string };
	Body: { drain: boolean };
}>("/v1/agents/:id/drain", async (req, reply) => {
	const a = agents.get(req.params.id);
	if (!a) return reply.code(404).send({ error: "Not Found" });
	a.drain = !!req.body.drain;
	broadcastUI(Msg.UIAgentUpdate, toPublicAgent(a));
	return { ok: true, agent: toPublicAgent(a) };
});

app.put<{
	Params: { id: string };
	Body: { meta?: Record<string, unknown> };
}>("/v1/agents/:id/meta", async (req, reply) => {
	const a = agents.get(req.params.id);
	if (!a) return reply.code(404).send({ error: "Agent not found" });
	
	if (req.body.meta !== undefined) {
		a.meta = { ...a.meta, ...req.body.meta };
		broadcastUI(Msg.UIAgentUpdate, toPublicAgent(a));
	}
	
	return { ok: true, agent: toPublicAgent(a) };
});

// Helper function to reboot a single agent via SSH
async function rebootAgentViaSSH(agent: AgentNode, reason: string): Promise<{ success: boolean; agentId: string; agentName: string; host: string; error?: string }> {
	// Get SSH configuration from environment variables
	const sshUser = process.env.AGENT_SSH_USER || 'Administrator';
	const sshKeyPath = process.env.AGENT_KEY_PATH;
	const rebootCommand = process.env.AGENT_REBOOT_COMMAND || 'shutdown /r /f /t 0';
	
	// Get SSH host from agent's remote address (stored when WebSocket connects)
	// Fallback to AGENT_SSH_HOST env var or agent name
	const sshHost = agent.remoteAddress || process.env.AGENT_SSH_HOST || agent.name;
	
	if (!sshHost) {
		return {
			success: false,
			agentId: agent.id,
			agentName: agent.name,
			host: '',
			error: "Cannot determine SSH host. Ensure agent is connected or set AGENT_SSH_HOST environment variable."
		};
	}

	console.log(`🔄 Attempting SSH reboot for agent ${agent.id} (${agent.name}) at ${sshHost}`);

	try {
		// Normalize key path for Windows
		let normalizedKeyPath: string | undefined = undefined;
		if (sshKeyPath && sshKeyPath.trim()) {
			const rawKeyPath = sshKeyPath.trim();
			
			// Verify key file exists
			if (!existsSync(rawKeyPath)) {
				console.warn(`⚠️  SSH key file not found: ${rawKeyPath}`);
				console.warn(`   Will attempt SSH without key file (may prompt for password)`);
				normalizedKeyPath = undefined;
			} else {
				console.log(`✅ SSH key file found: ${rawKeyPath}`);
				// Convert Windows backslashes to forward slashes for SSH
				// Windows OpenSSH supports both formats, but forward slashes are more reliable
				normalizedKeyPath = rawKeyPath.replace(/\\/g, '/');
			}
		}
		
		// Build SSH command
		let sshCommand: string;
		if (normalizedKeyPath) {
			// Escape quotes in the path for shell safety
			const escapedKeyPath = normalizedKeyPath.replace(/"/g, '\\"');
			// Use additional SSH options to force key authentication and prevent password prompts
			// If key auth fails, SSH will error instead of prompting for password
			sshCommand = `ssh -i "${escapedKeyPath}" -o StrictHostKeyChecking=no -o PasswordAuthentication=no -o PreferredAuthentications=publickey ${sshUser}@${sshHost} "${rebootCommand}"`;
		} else {
			sshCommand = `ssh -o StrictHostKeyChecking=no ${sshUser}@${sshHost} "${rebootCommand}"`;
		}

		// Log command with key path masked for security
		const logCommand = normalizedKeyPath 
			? sshCommand.replace(normalizedKeyPath.replace(/\\/g, '/'), '[KEY_PATH]')
			: sshCommand;
		console.log(`Executing SSH command: ${logCommand}`);
		if (normalizedKeyPath) {
			console.log(`Using SSH key file: ${normalizedKeyPath}`);
		} else {
			console.log(`No SSH key specified, using default SSH keys`);
		}

		// Execute SSH command (don't wait for completion since machine will reboot)
		execAsync(sshCommand).catch((error) => {
			// It's normal for SSH to fail when the machine reboots, but log other errors
			if (error.message && !error.message.includes('Connection closed') && !error.message.includes('closed by remote host')) {
				console.error(`SSH command error for agent ${agent.name}:`, error.message);
				console.error(`Full error:`, error);
			} else {
				console.log(`SSH command executed for agent ${agent.name} (connection closed due to reboot)`);
			}
		});

		return {
			success: true,
			agentId: agent.id,
			agentName: agent.name,
			host: sshHost
		};
	} catch (error) {
		console.error(`Failed to reboot agent ${agent.name} via SSH:`, error);
		return {
			success: false,
			agentId: agent.id,
			agentName: agent.name,
			host: sshHost,
			error: error instanceof Error ? error.message : 'Unknown error'
		};
	}
}

app.post<{
	Params: { id: string };
	Body: { reason?: string };
}>("/v1/agents/:id/reboot", async (req, reply) => {
	const agentId = req.params.id;
	const a = agents.get(agentId);
	if (!a) return reply.code(404).send({ error: "Agent not found" });

	const reason = req.body.reason || 'Reboot requested from UI';
	const result = await rebootAgentViaSSH(a, reason);

	if (!result.success) {
		return reply.code(500).send({ 
			error: "Failed to execute SSH reboot",
			message: result.error || 'Unknown error'
		});
	}

	return reply.code(202).send({ 
		ok: true, 
		message: 'Reboot command sent via SSH',
		method: 'ssh',
		host: result.host
	});
});

app.post<{
	Body: { reason?: string };
}>("/v1/agents/reboot-all", async (req, reply) => {
	const reason = req.body.reason || 'Reboot all agents requested from UI';
	const agentList = Array.from(agents.values());
	
	if (agentList.length === 0) {
		return reply.code(200).send({
			ok: true,
			message: 'No agents to reboot',
			results: []
		});
	}

	console.log(`🔄 Attempting to reboot all ${agentList.length} agents`);

	// Reboot all agents in parallel (don't wait for completion)
	const results = await Promise.allSettled(
		agentList.map(agent => rebootAgentViaSSH(agent, reason))
	);

	const rebootResults = results.map((result, idx) => {
		if (result.status === 'fulfilled') {
			return result.value;
		} else {
			return {
				success: false,
				agentId: agentList[idx].id,
				agentName: agentList[idx].name,
				host: agentList[idx].remoteAddress || agentList[idx].name || 'unknown',
				error: result.reason?.message || 'Unknown error'
			};
		}
	});

	const successCount = rebootResults.filter(r => r.success).length;
	const failureCount = rebootResults.filter(r => !r.success).length;

	console.log(`✅ Reboot initiated for ${successCount} agents, ${failureCount} failed`);

	return reply.code(202).send({
		ok: true,
		message: `Reboot commands sent to ${successCount} agent(s), ${failureCount} failed`,
		results: rebootResults
	});
});

// Jobs REST
app.get("/v1/jobs", async (req) => {
	return Array.from(jobs.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
});

app.get<{ Params: { id: string } }>("/v1/jobs/:id", async (req, reply) => {
	const j = jobs.get(req.params.id);
	if (!j) return reply.code(404).send({ error: "Not Found" });
	return j;
});

app.post<{
	Body: {
		templateId?: string;
		inlineConfig?: Record<string, unknown>;
		idempotencyKey?: string;
		restartPolicy?: "never" | "onFailure";
		streamContext?: {
			context?: string;
			drawNumber?: number;
			sheet?: 'A' | 'B' | 'C' | 'D' | 'vibe';
			team1?: string;
			team2?: string;
		};
	};
}>("/v1/jobs", async (req, reply) => {
	console.log('📨 Server received job creation request', {
		idempotencyKey: req.body.idempotencyKey,
		streamKey: req.body.inlineConfig?.streamKey,
		timestamp: new Date().toISOString(),
		requestId: Math.random().toString(36).substr(2, 9)
	});

	const { templateId, inlineConfig, idempotencyKey, restartPolicy, streamContext } = req.body;

	// Global rate limit check: prevent rapid-fire job creation requests
	const now = Date.now();
	console.log('🔒 Server job creation rate limit check', {
		now,
		recentJobsCount: recentJobCreations.length,
		burstAllowance: BURST_ALLOWANCE,
		isWithinBurst: recentJobCreations.length < BURST_ALLOWANCE
	});

	if (!checkJobCreationRateLimit()) {
		console.error('❌ Job creation rate limit exceeded: minimum 2 seconds between requests');
		return reply.code(429).send({
			error: "Job creation rate limit exceeded. Please wait at least 2 seconds between job creation requests.",
			code: "JOB_CREATION_RATE_LIMIT"
		});
	}

	// Record this job creation attempt for rate limiting
	recordJobCreation();
	console.log('✅ Server job creation rate limit passed, total recent jobs:', recentJobCreations.length);

	if (!!templateId === !!inlineConfig) {
		return reply.code(422).send({
			error: "Exactly one of templateId or inlineConfig is required",
		});
	}

	if (idempotencyKey && pendingByIdem.has(idempotencyKey)) {
		const jobId = pendingByIdem.get(idempotencyKey)!;
		return reply.code(200).send(jobs.get(jobId));
	}

	// Create job with CREATED status initially (not PENDING)
	const job = createJob(
		{
			templateId: templateId ?? null,
			inlineConfig: inlineConfig ?? null,
			idempotencyKey,
			restartPolicy,
			status: "CREATED" // Don't make it PENDING yet
		},
		"ui"
	);

	console.log(`Created job ${job.id} with initial status: ${job.status}`);

	if (idempotencyKey) pendingByIdem.set(idempotencyKey, job.id);

	// Auto-create YouTube stream for new jobs
	try {
		let title: string;
		let description: string;

		// Check if custom title/description were provided in inlineConfig
		const customTitle = inlineConfig?.title as string | undefined;
		const customDescription = inlineConfig?.description as string | undefined;
		const hasCustomTitle = customTitle && customTitle.trim() !== '';
		const hasCustomDescription = customDescription && customDescription.trim() !== '';

		// Use custom title if provided, otherwise auto-generate
		if (hasCustomTitle) {
			title = customTitle.trim();
			console.log(`Using custom title: "${title}"`);
		} else if (streamContext) {
			title = generateStreamTitle(streamContext);
			console.log(`Auto-generated title: "${title}"`);
		} else {
			title = YouTubeService.generateStreamTitle();
			console.log(`Using default title: "${title}"`);
		}

		// Use custom description if provided, otherwise auto-generate
		if (hasCustomDescription) {
			description = customDescription.trim();
			console.log(`Using custom description: "${description}"`);
		} else if (streamContext) {
			description = generateStreamDescription(streamContext);
			console.log(`Auto-generated description: "${description}"`);
		} else {
			description = YouTubeService.generateStreamDescription();
			console.log(`Using default description: "${description}"`);
		}

		// Check rate limit for YouTube broadcast creation
		if (!checkBroadcastRateLimit()) {
			console.error('YouTube broadcast creation rate limit exceeded: max 10 per 10 minutes');

			// Fail the job creation due to rate limit
			updateJob(job.id, {
				status: "FAILED",
				error: {
					code: "RATE_LIMIT_EXCEEDED",
					message: "YouTube broadcast creation rate limit exceeded. Maximum 10 broadcasts per 10 minutes allowed."
				}
			});

			console.log(`Job ${job.id} failed due to rate limit`);
			return reply.code(201).send(jobs.get(job.id));
		}

		const youtubeMetadata = await youtubeService.createLiveBroadcast(title, description, currentStreamPrivacy);

		// Record successful broadcast creation for rate limiting
		recordBroadcastCreation();

		console.log(`YouTube metadata created:`, {
			videoId: youtubeMetadata.videoId,
			streamUrl: youtubeMetadata.streamUrl,
			streamKey: youtubeMetadata.streamKey,
			hasStreamUrl: !!youtubeMetadata.streamUrl,
			hasStreamKey: !!youtubeMetadata.streamKey
		});

		// Update job with YouTube metadata and stream context
		const streamMetadata = {
			title,
			description,
			platform: 'youtube',
			publicUrl: `https://youtube.com/live/${youtubeMetadata.videoId}`,
			adminUrl: `https://studio.youtube.com/video/${youtubeMetadata.videoId}`,
			youtube: youtubeMetadata,
			streamContext, // Store the context for future reference
		};

		// Now mark the job as PENDING so it can be scheduled
		updateJob(job.id, {
			streamMetadata,
			status: "PENDING"
		});

		console.log(`Updated job ${job.id} with YouTube stream metadata and marked as PENDING`);
	} catch (error) {
		console.error('Failed to create YouTube stream:', error);

		// Fail the job creation if YouTube setup fails
		const errorMessage = error instanceof Error ? error.message : 'Unknown YouTube API error';
		updateJob(job.id, {
			status: "FAILED",
			error: {
				code: "YOUTUBE_SETUP_FAILED",
				message: `Failed to create YouTube broadcast: ${errorMessage}`
			}
		});

		console.log(`Job ${job.id} failed due to YouTube setup error: ${errorMessage}`);

		// Return the failed job
		return reply.code(201).send(jobs.get(job.id));
	}

	return reply.code(201).send(jobs.get(job.id));
});

app.post<{ Params: { id: string } }>("/v1/jobs/:id/stop", async (req, reply) => {
	const job = jobs.get(req.params.id);
	if (!job) return reply.code(404).send({ error: "Not Found" });
	if (!job.agentId) {
		updateJob(job.id, { status: "CANCELED", endedAt: new Date().toISOString() });
		streamHealth.delete(job.id);
		pendingRestarts.delete(job.id);
		void endBroadcastForJob(job, "job canceled without agent");
		return reply.code(202).send({ ok: true, job: jobs.get(job.id) });
	}
	const agent = agents.get(job.agentId);
	if (!agent || agent.state === "OFFLINE" || !agent.ws) {
		updateJob(job.id, { status: "UNKNOWN" });
		return reply.code(202).send({ ok: true, job: jobs.get(job.id) });
	}
	const msg: WSMessage = {
		type: Msg.OrchestratorJobStop,
		msgId: randomUUID(),
		ts: new Date().toISOString(),
		payload: { jobId: job.id, reason: "User requested", deadlineMs: STOP_GRACE_MS },
	};
	agent.ws.send(JSON.stringify(msg));
	updateJob(job.id, { status: "STOPPING" });
	return reply.code(202).send({ ok: true, job: jobs.get(job.id) });
});

app.post<{ Params: { id: string } }>("/v1/jobs/:id/dismiss", async (req, reply) => {
	const job = jobs.get(req.params.id);
	if (!job) return reply.code(404).send({ error: "Not Found" });

	updateJob(job.id, { status: "DISMISSED", endedAt: new Date().toISOString() });
	streamHealth.delete(job.id);
	pendingRestarts.delete(job.id);
	void endBroadcastForJob(job, "job dismissed");
	console.log(`Job ${job.id} dismissed by user`);
	return reply.code(200).send({ ok: true, job: jobs.get(job.id) });
});

// Stream metadata management
app.get<{ Params: { id: string } }>("/v1/jobs/:id/metadata", async (req, reply) => {
	const job = jobs.get(req.params.id);
	if (!job) return reply.code(404).send({ error: "Not Found" });
	return { metadata: job.streamMetadata ?? {} };
});

app.put<{
	Params: { id: string };
	Body: StreamMetadata;
}>("/v1/jobs/:id/metadata", async (req, reply) => {
	const job = jobs.get(req.params.id);
	if (!job) return reply.code(404).send({ error: "Not Found" });

	const updatedMetadata = { ...job.streamMetadata, ...req.body };
	updateJob(job.id, { streamMetadata: updatedMetadata });

	// If title or description is being updated and we have a YouTube broadcast, schedule a debounced update
	const isRunning = job.status === "RUNNING" || job.status === "STARTING";
	const broadcastId = job.streamMetadata?.youtube?.broadcastId;
	const hasUpdates = req.body.title !== undefined || req.body.description !== undefined;

	if (isRunning && broadcastId && hasUpdates) {
		const youtubeUpdates: { title?: string; description?: string } = {};
		if (req.body.title !== undefined) youtubeUpdates.title = req.body.title;
		if (req.body.description !== undefined) youtubeUpdates.description = req.body.description;

		scheduleYouTubeMetadataUpdate(job.id, broadcastId, youtubeUpdates);
	}

	return reply.code(200).send({ ok: true, metadata: updatedMetadata });
});

/**
 * Schedule a debounced YouTube metadata update
 * Waits 10 seconds after the last update before actually calling YouTube API
 */
function scheduleYouTubeMetadataUpdate(jobId: string, broadcastId: string, updates: { title?: string; description?: string }) {
	// Cancel any existing pending update for this job
	const existing = pendingYouTubeUpdates.get(jobId);
	if (existing) {
		clearTimeout(existing.timer);
	}

	// Merge new updates with any existing pending updates
	const mergedUpdates = existing 
		? { ...existing.updates, ...updates }
		: updates;

	// Schedule new update after 10 seconds
	const timer = setTimeout(async () => {
		console.log(`Executing debounced YouTube metadata update for broadcast ${broadcastId}:`, mergedUpdates);
		
		try {
			await youtubeService.updateBroadcast(broadcastId, mergedUpdates);
			console.log(`✅ Successfully updated YouTube broadcast ${broadcastId}`);
		} catch (error) {
			console.error(`❌ Failed to update YouTube broadcast ${broadcastId}:`, error);
		} finally {
			// Remove from pending updates
			pendingYouTubeUpdates.delete(jobId);
		}
	}, 10000); // 10 second debounce

	// Store the pending update
	pendingYouTubeUpdates.set(jobId, {
		timer,
		broadcastId,
		updates: mergedUpdates,
	});

	console.log(`Scheduled YouTube metadata update for broadcast ${broadcastId} (will execute in 10s)`);
}

// Mute control endpoints
app.post<{ Params: { id: string } }>("/v1/jobs/:id/mute", async (req, reply) => {
	const job = jobs.get(req.params.id);
	if (!job) return reply.code(404).send({ error: "Not Found" });

	const agent = agents.get(job.agentId!);
	if (!agent || agent.state === "OFFLINE" || !agent.ws) {
		return reply.code(409).send({ error: "Agent not available" });
	}

	const msg: WSMessage = {
		type: Msg.OrchestratorJobMute,
		msgId: randomUUID(),
		ts: new Date().toISOString(),
		payload: { jobId: job.id },
	};
	agent.ws.send(JSON.stringify(msg));

	// Update local metadata
	const updatedMetadata = { ...job.streamMetadata, isMuted: true };
	updateJob(job.id, { streamMetadata: updatedMetadata });

	return reply.code(202).send({ ok: true, job: jobs.get(job.id) });
});

app.post<{ Params: { id: string } }>("/v1/jobs/:id/unmute", async (req, reply) => {
	const job = jobs.get(req.params.id);
	if (!job) return reply.code(404).send({ error: "Not Found" });

	const agent = agents.get(job.agentId!);
	if (!agent || agent.state === "OFFLINE" || !agent.ws) {
		return reply.code(409).send({ error: "Agent not available" });
	}

	const msg: WSMessage = {
		type: Msg.OrchestratorJobUnmute,
		msgId: randomUUID(),
		ts: new Date().toISOString(),
		payload: { jobId: job.id },
	};
	agent.ws.send(JSON.stringify(msg));

	// Update local metadata
	const updatedMetadata = { ...job.streamMetadata, isMuted: false };
	updateJob(job.id, { streamMetadata: updatedMetadata });

	return reply.code(202).send({ ok: true, job: jobs.get(job.id) });
});

// Pause control endpoints (stop sending packets, keep broadcast alive)
app.post<{ Params: { id: string } }>("/v1/jobs/:id/pause", async (req, reply) => {
	const job = jobs.get(req.params.id);
	if (!job) return reply.code(404).send({ error: "Not Found" });

	const agent = agents.get(job.agentId!);
	if (!agent || agent.state === "OFFLINE" || !agent.ws) {
		return reply.code(409).send({ error: "Agent not available" });
	}

	const msg: WSMessage = {
		type: Msg.OrchestratorJobPause,
		msgId: randomUUID(),
		ts: new Date().toISOString(),
		payload: { jobId: job.id },
	};
	agent.ws.send(JSON.stringify(msg));

	const updatedMetadata = { ...job.streamMetadata, isPaused: true };
	updateJob(job.id, { streamMetadata: updatedMetadata });
	emitJobEvent(job.id, "stream.pause_requested", "Pause requested");

	return reply.code(202).send({ ok: true, job: jobs.get(job.id) });
});

app.post<{ Params: { id: string } }>("/v1/jobs/:id/unpause", async (req, reply) => {
	const job = jobs.get(req.params.id);
	if (!job) return reply.code(404).send({ error: "Not Found" });

	const agent = agents.get(job.agentId!);
	if (!agent || agent.state === "OFFLINE" || !agent.ws) {
		return reply.code(409).send({ error: "Agent not available" });
	}

	const msg: WSMessage = {
		type: Msg.OrchestratorJobUnpause,
		msgId: randomUUID(),
		ts: new Date().toISOString(),
		payload: { jobId: job.id },
	};
	agent.ws.send(JSON.stringify(msg));

	const updatedMetadata = { ...job.streamMetadata, isPaused: false };
	updateJob(job.id, { streamMetadata: updatedMetadata });
	emitJobEvent(job.id, "stream.unpause_requested", "Unpause requested");

	return reply.code(202).send({ ok: true, job: jobs.get(job.id) });
});

/**
 * WebSocket servers
 */
const server = app.server as unknown as import("http").Server;

const wssAgents = new WebSocketServer({ noServer: true });
const wssUi = new WebSocketServer({ noServer: true });
const wssBrowserSource = new WebSocketServer({ noServer: true });
const wssStatus = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
	const { url } = req;
	console.log(`WebSocket upgrade request: ${url}`);
	
	// Apply IP-based access control for WebSocket connections
	if (ENABLE_PUBLIC_ACCESS_RESTRICTIONS) {
		// Get client IP (handle X-Forwarded-For from reverse proxy)
		const forwardedFor = req.headers['x-forwarded-for'];
		const realIP = req.headers['x-real-ip'];
		let clientIP: string = 'unknown';
		
		if (forwardedFor) {
			clientIP = (typeof forwardedFor === 'string' ? forwardedFor.split(',')[0].trim() : forwardedFor[0]);
		} else if (realIP && typeof realIP === 'string') {
			clientIP = realIP;
		} else if (req.socket?.remoteAddress) {
			clientIP = req.socket.remoteAddress;
		}
		
		const isTrusted = isTrustedIP(clientIP);
		
		// Check if this is a public WebSocket path
		const isPublicPath = Array.from(PUBLIC_WS_PATHS).some(path => url?.startsWith(path));
		
		// If not from trusted IP and not a public path, reject
		if (!isTrusted && !isPublicPath) {
			console.warn(`❌ Rejected external WebSocket connection from ${clientIP} to ${url}`);
			socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
			socket.destroy();
			return;
		}
		
		if (!isTrusted && isPublicPath) {
			console.log(`✅ Allowed public WebSocket connection from ${clientIP} to ${url}`);
		}
	}
	
	// Accept any origin for WebSocket connections (required for CORS)
	// This is safe for public endpoints like status and teamnames
	const origin = req.headers.origin;
	
	if (url?.startsWith("/agent")) {
		console.log(`Upgrading agent WebSocket connection`);
		wssAgents.handleUpgrade(req, socket, head, (ws) => {
			console.log(`Agent WebSocket connection established`);
			// Store req in ws for later access
			(ws as any)._req = req;
			wssAgents.emit("connection", ws, req);
		});
	} else if (url?.startsWith("/ui")) {
		console.log(`Upgrading UI WebSocket connection`);
		wssUi.handleUpgrade(req, socket, head, (ws) => {
			console.log(`UI WebSocket connection established`);
			wssUi.emit("connection", ws, req);
		});
	} else if (url?.startsWith("/status-ws")) {
		console.log(`Upgrading status WebSocket connection from origin: ${origin || 'unknown'}`);
		wssStatus.handleUpgrade(req, socket, head, (ws) => {
			console.log(`Status WebSocket connection established`);
			wssStatus.emit("connection", ws, req);
		});
	} else if (url?.startsWith("/teamnames-ws")) {
		console.log(`Upgrading browser source WebSocket connection`);
		wssBrowserSource.handleUpgrade(req, socket, head, (ws) => {
			console.log(`Browser source WebSocket connection established`);
			wssBrowserSource.emit("connection", ws, req);
		});
	} else {
		console.log(`Rejecting WebSocket upgrade for unknown path: ${url}`);
		socket.destroy();
	}
});

wssUi.on("connection", (ws) => {
	uiClients.add(ws);
	ws.on("close", () => uiClients.delete(ws));
	// Push initial snapshot
	ws.send(
		JSON.stringify({
			type: Msg.UIAgentUpdate,
			msgId: randomUUID(),
			ts: new Date().toISOString(),
			payload: Array.from(agents.values()).map(toPublicAgent),
		})
	);
	ws.send(
		JSON.stringify({
			type: Msg.UIJobUpdate,
			msgId: randomUUID(),
			ts: new Date().toISOString(),
			payload: Array.from(jobs.values()),
		})
	);
});

wssStatus.on("connection", (ws) => {
	statusClients.add(ws);
	console.log(`Status client connected. Total clients: ${statusClients.size}`);
	
	// Send initial status snapshot
	try {
		const statusData = getStatusData();
		ws.send(JSON.stringify({
			type: 'status.update',
			ts: new Date().toISOString(),
			payload: statusData,
		}));
	} catch (error) {
		console.error('Error sending initial status to client:', error);
	}
	
	ws.on("close", () => {
		statusClients.delete(ws);
		console.log(`Status client disconnected. Total clients: ${statusClients.size}`);
	});
	
	ws.on("error", (error) => {
		console.error('Status WebSocket error:', error);
	});
});

wssBrowserSource.on("connection", (ws) => {
	let registeredKey: string | null = null;

	ws.on("message", (raw) => {
		try {
			const msg = JSON.parse(String(raw));
			if (msg.type === 'register') {
				const { sheet, color } = msg;
				if (teamNames[sheet] && (color === 'red' || color === 'yellow')) {
					registeredKey = `${sheet}:${color}`;
					
					// Add to the appropriate client set
					if (!browserSourceClients.has(registeredKey)) {
						browserSourceClients.set(registeredKey, new Set());
					}
					browserSourceClients.get(registeredKey)!.add(ws);
					
					console.log(`Browser source registered: ${registeredKey}`);
					
					// Send initial team name
					ws.send(JSON.stringify({
						type: 'teamname.update',
						sheet,
						color,
						teamName: teamNames[sheet][color as 'red' | 'yellow'],
						ts: new Date().toISOString(),
					}));
				}
			}
		} catch (err) {
			console.error('Failed to parse browser source message:', err);
		}
	});

	ws.on("close", () => {
		if (registeredKey) {
			const clients = browserSourceClients.get(registeredKey);
			if (clients) {
				clients.delete(ws);
				if (clients.size === 0) {
					browserSourceClients.delete(registeredKey);
				}
			}
			console.log(`Browser source disconnected: ${registeredKey}`);
		}
	});
});

/**
 * Agent protocol handling
 */
type PendingAck = {
	resolve: (ok: boolean) => void;
	timer: NodeJS.Timeout;
};
const pendingAssignAcks = new Map<string, PendingAck>(); // correlationId -> waiter

wssAgents.on("connection", (ws, req) => {
	let attachedAgentId: string | null = null;
	
	// Get remote address from WebSocket connection or request
	const reqObj = req || (ws as any)._req;
	const remoteAddress = (ws as any)._socket?.remoteAddress || 
		reqObj?.socket?.remoteAddress || 
		(reqObj?.headers?.['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
		(reqObj?.headers?.['x-real-ip'] as string);

	console.log(`[DEBUG] New WebSocket connection from ${remoteAddress || 'unknown'}, readyState: ${ws.readyState}`);

	ws.on("error", (error) => {
		console.error(`[ERROR] WebSocket error for agent ${attachedAgentId || 'unknown'} from ${remoteAddress || 'unknown'}:`, error);
		console.error(`[ERROR] Error details:`, {
			message: error.message,
			stack: error.stack,
			code: (error as any).code,
			errno: (error as any).errno,
			syscall: (error as any).syscall
		});
		// Try to close the connection gracefully on error
		try {
			if (ws.readyState === WebSocket.OPEN) {
				console.log(`[DEBUG] Closing WebSocket due to error with code 1011`);
				ws.close(1011, "Internal server error");
			} else {
				console.log(`[DEBUG] WebSocket already closed (readyState: ${ws.readyState}), not closing`);
			}
		} catch (e) {
			console.error(`[ERROR] Error closing WebSocket after error:`, e);
		}
	});

	ws.on("message", (raw) => {
		let msg: WSMessage<any>;
		try {
			msg = JSON.parse(String(raw));
		} catch {
			return;
		}

		if (msg.type === Msg.AgentHello) {
			const { agentId, name, version, capabilities, drain, activeJob, auth } = msg.payload as {
				agentId: string;
				name: string;
				version: string;
				capabilities: { slots: number; maxResolution?: string };
				drain: boolean;
				activeJob?: { jobId: string; status: JobStatus } | null;
				auth: { token: string };
			};

			if (auth?.token !== AGENT_TOKEN) {
				console.warn(`Agent authentication failed for ${name} (${agentId}): invalid token`);
				ws.close(4001, "Unauthorized");
				return;
			}

			console.log(`Agent Hello received - ID: ${agentId}, Name: ${name}, Auth token: ${auth?.token ? 'provided' : 'missing'}`);
			let agent = agents.get(agentId);
			if (!agent) {
				console.log(`New agent ${name} (${agentId}) connecting from ${remoteAddress || 'unknown'}`);
				agent = {
					id: agentId,
					name,
					version,
					state: "IDLE",
					currentJobId: null,
					lastSeenAt: new Date().toISOString(),
					drain: !!drain,
					capabilities,
					meta: {},
					error: null,
					ws,
					remoteAddress,
					timers: {},
				};
				agents.set(agentId, agent);
			} else {
				console.log(`Agent ${name} (${agentId}) reconnecting from ${remoteAddress || 'unknown'}`);
				console.log(`[DEBUG] Existing agent found. Current WebSocket state: ${agent.ws ? `exists, readyState: ${agent.ws.readyState}` : 'null'}, New WebSocket readyState: ${ws.readyState}`);
				
				// Always allow reconnection - clean up any existing WebSocket
				if (agent.ws && agent.ws !== ws) {
					const oldWs = agent.ws;
					console.log(`[DEBUG] Old WebSocket found (different instance), cleaning up. Old readyState: ${oldWs.readyState}, New readyState: ${ws.readyState}`);
					
					// Remove close handler from old WebSocket to prevent it from setting agent offline
					oldWs.removeAllListeners('close');
					oldWs.removeAllListeners('error');
					oldWs.removeAllListeners('message');
					
					if (oldWs.readyState === WebSocket.OPEN) {
						console.log(`[DEBUG] Old WebSocket is OPEN, closing it gracefully`);
						console.log(`Closing previous WebSocket for agent ${agentId}`);
						try {
							oldWs.close(1000, "Replaced by new connection"); // Use normal closure code
						} catch (e) {
							console.error(`[ERROR] Error closing old WebSocket:`, e);
							// Ignore errors when closing old connection
						}
					} else {
						console.log(`[DEBUG] Old WebSocket already closed (readyState: ${oldWs.readyState}), not closing`);
					}
				} else if (agent.ws === ws) {
					console.log(`[DEBUG] Same WebSocket instance - this is likely a duplicate Hello message, not a reconnection`);
				} else {
					console.log(`[DEBUG] No existing WebSocket to clean up`);
				}
			}
			agent.ws = ws;
			agent.remoteAddress = remoteAddress; // Update remote address on reconnect
			agent.name = name;
			agent.version = version;
			agent.capabilities = capabilities;
			agent.drain = !!drain;
			agent.lastSeenAt = new Date().toISOString();
			attachedAgentId = agentId;

			setAgentState(agent, agent.state === "OFFLINE" ? "IDLE" : agent.state);
			console.log(`Agent ${name} (${agentId}) successfully connected`);

			// Reconcile active job (if any)
			if (activeJob?.jobId) {
				const j = jobs.get(activeJob.jobId);
				if (j) {
					updateJob(j.id, { status: activeJob.status, agentId: agent.id });
					agent.currentJobId = j.id;
				} else {
					const recovered: Job = {
						id: activeJob.jobId,
						templateId: null,
						inlineConfig: null,
						status: activeJob.status,
						agentId: agent.id,
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
						startedAt: new Date().toISOString(),
						endedAt: null,
						error: null,
						requestedBy: "recovered",
						idempotencyKey: undefined,
						restartPolicy: "never",
					};
					jobs.set(recovered.id, recovered);
					broadcastUI(Msg.UIJobUpdate, recovered);
					agent.currentJobId = recovered.id;
				}
			}

			// Hello OK
			const ok: WSMessage = {
				type: Msg.OrchestratorHelloOk,
				msgId: randomUUID(),
				ts: new Date().toISOString(),
				payload: {
					heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
					heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
					stopGraceMs: STOP_GRACE_MS,
					killAfterMs: KILL_AFTER_MS,
				},
			};
			ws.send(JSON.stringify(ok));

			schedule();
			return;
		}

		if (!attachedAgentId) return; // ignore pre-hello messages
		const agent = agents.get(attachedAgentId);
		if (!agent) return;

		// Liveness update
		agent.lastSeenAt = new Date().toISOString();
		if (agent.timers.heartbeatTimeout) {
			clearTimeout(agent.timers.heartbeatTimeout);
		}
		agent.timers.heartbeatTimeout = setTimeout(() => {
			setAgentState(agent, "OFFLINE");
			if (agent.currentJobId) {
				const j = jobs.get(agent.currentJobId);
				if (j && ["RUNNING", "STARTING", "STOPPING"].includes(j.status)) {
					updateJob(j.id, { status: "UNKNOWN" });
					// Optionally fail after timeout window
					setTimeout(() => {
						const jj = jobs.get(j.id);
						if (jj && jj.status === "UNKNOWN") {
							updateJob(j.id, {
								status: "FAILED",
								endedAt: new Date().toISOString(),
								error: { code: "AGENT_OFFLINE", message: "Agent offline" },
							});
							void endBroadcastForJob(jj, "agent offline");
						}
					}, HEARTBEAT_TIMEOUT_MS);
				}
			}
		}, HEARTBEAT_TIMEOUT_MS + 1000);

		switch (msg.type) {
			case Msg.AgentHeartbeat: {
				// Already updated lastSeenAt and timer
				break;
			}
			case Msg.AgentAssignAck: {
				const corr = msg.correlationId!;
				const waiter = pendingAssignAcks.get(corr);
				if (waiter) {
					pendingAssignAcks.delete(corr);
					const { accepted } = msg.payload as {
						jobId: string;
						accepted: boolean;
						reason?: string;
					};
					waiter.resolve(accepted);
				}
				break;
			}
			case Msg.AgentJobUpdate: {
				const { jobId, status } = msg.payload as {
					jobId: string;
					status: JobStatus;
				};
				const j = jobs.get(jobId);
				if (!j) break;

				// Update agent state based on job status
				if (status === "RUNNING" && agent.currentJobId === jobId) {
					setAgentState(agent, "RUNNING");
				}

				if (status === "RUNNING" && !j.startedAt) updateJob(jobId, { status, startedAt: new Date().toISOString() });
				else updateJob(jobId, { status });
				break;
			}
			case Msg.AgentJobStopped: {
				const { jobId, status, error } = msg.payload as {
					jobId: string;
					status: "STOPPED" | "FAILED";
					error?: { code: string; message: string };
				};
				const j = jobs.get(jobId);
				if (j) {
					if (j.status === "FAILED" && j.error?.code === "STREAM_RESTART_EXCEEDED") {
						updateJob(jobId, { endedAt: new Date().toISOString() });
						void endBroadcastForJob(j, "restart attempts exhausted");
						emitJobEvent(jobId, "stream.restart_exhausted_stop", "Stream stopped after restart exhaustion");
						streamHealth.delete(jobId);
						pendingRestarts.delete(jobId);
						break;
					}

					if (pendingRestarts.has(jobId)) {
						pendingRestarts.delete(jobId);
						updateJob(jobId, {
							status: "PENDING",
							agentId: null,
							startedAt: null,
							endedAt: null,
							error: null,
							streamMetadata: { ...j.streamMetadata, isPaused: false },
						});
						const health = streamHealth.get(jobId);
						if (health) {
							health.firstInactiveAt = undefined;
							health.nextRestartAt = undefined;
							streamHealth.set(jobId, health);
						}
						emitJobEvent(jobId, "stream.restart_ready", "Stream restart queued");
					} else {
						// Clear title and description when stream stops so they can be auto-generated next time
						const clearedMetadata = j.streamMetadata ? {
							...j.streamMetadata,
							title: '',
							description: '',
						} : undefined;

						updateJob(jobId, {
							status,
							endedAt: new Date().toISOString(),
							error: error ?? null,
							streamMetadata: clearedMetadata,
						});
						void endBroadcastForJob(j, "job stopped");
						emitJobEvent(jobId, "stream.stopped", "Stream stopped", { status, error });
						streamHealth.delete(jobId);
						pendingRestarts.delete(jobId);

						// Cancel any pending YouTube updates for this job
						const pending = pendingYouTubeUpdates.get(jobId);
						if (pending) {
							clearTimeout(pending.timer);
							pendingYouTubeUpdates.delete(jobId);
							console.log(`Cancelled pending YouTube update for stopped job ${jobId}`);
						}
					}
				}
				if (agent.currentJobId === jobId) {
					agent.currentJobId = null;
					setAgentState(agent, agent.drain ? "DRAINING" : "IDLE");
				}
				break;
			}
			case Msg.AgentError: {
				agent.error = msg.payload;
				setAgentState(agent, "ERROR");
				break;
			}
			case Msg.AgentJobMute: {
				const { jobId, success } = msg.payload as {
					jobId: string;
					success: boolean;
				};
				const j = jobs.get(jobId);
				if (j) {
					const updatedMetadata = { ...j.streamMetadata, isMuted: success };
					updateJob(jobId, { streamMetadata: updatedMetadata });
				}
				break;
			}
			case Msg.AgentJobUnmute: {
				const { jobId, success } = msg.payload as {
					jobId: string;
					success: boolean;
				};
				const j = jobs.get(jobId);
				if (j) {
					const updatedMetadata = { ...j.streamMetadata, isMuted: !success };
					updateJob(jobId, { streamMetadata: updatedMetadata });
				}
				break;
			}
			case Msg.AgentJobPaused: {
				const { jobId, success } = msg.payload as {
					jobId: string;
					success: boolean;
				};
				const j = jobs.get(jobId);
				if (j) {
					const updatedMetadata = { ...j.streamMetadata, isPaused: success };
					updateJob(jobId, { streamMetadata: updatedMetadata });
					emitJobEvent(jobId, success ? "stream.paused" : "stream.pause_failed", success ? "Stream paused" : "Stream pause failed");
				}
				break;
			}
			case Msg.AgentJobUnpaused: {
				const { jobId, success } = msg.payload as {
					jobId: string;
					success: boolean;
				};
				const j = jobs.get(jobId);
				if (j) {
					const updatedMetadata = { ...j.streamMetadata, isPaused: !success };
					updateJob(jobId, { streamMetadata: updatedMetadata });
					emitJobEvent(jobId, success ? "stream.unpaused" : "stream.unpause_failed", success ? "Stream unpaused" : "Stream unpause failed");
				}
				break;
			}
			default:
				break;
		}
	});

	ws.on("close", (code, reason) => {
		console.log(`[DEBUG] WebSocket close event - Code: ${code}, Reason: ${reason?.toString() || 'No reason'}, Agent: ${attachedAgentId || 'unknown'}, Remote: ${remoteAddress || 'unknown'}`);
		
		if (!attachedAgentId) {
			console.log(`[DEBUG] No attached agent ID, ignoring close event`);
			return;
		}
		
		const agent = agents.get(attachedAgentId);
		if (!agent) {
			console.log(`[DEBUG] Agent ${attachedAgentId} not found in agents map, ignoring close event`);
			return;
		}
		
		// Only set offline if this is still the active WebSocket for the agent
		// This prevents old WebSocket close events from affecting reconnected agents
		if (agent.ws === ws) {
			console.log(`[DEBUG] This is the active WebSocket for agent ${agent.name} (${attachedAgentId}), setting offline`);
			console.log(`Agent ${agent.name} (${attachedAgentId}) disconnected - Code: ${code}, Reason: ${reason?.toString() || 'No reason'}`);
			setAgentState(agent, "OFFLINE");
			agent.ws = undefined; // Clear WebSocket reference
		} else {
			console.log(`[DEBUG] Ignoring close event from old WebSocket for agent ${attachedAgentId} (new connection active)`);
			console.log(`Ignoring close event from old WebSocket for agent ${attachedAgentId} (new connection active)`);
		}
	});
});

/**
 * Scheduler
 */
let scheduling = false;
let monitoring = false;

async function sendAssignAndAwaitAck(agent: AgentNode, job: Job, ttlMs = 5000): Promise<boolean> {
	if (!agent.ws) return false;
	const msg: WSMessage = {
		type: Msg.OrchestratorAssignStart,
		msgId: randomUUID(),
		ts: new Date().toISOString(),
		payload: {
			jobId: job.id,
			idempotencyKey: job.idempotencyKey ?? randomUUID(),
			config: job.inlineConfig ?? { templateId: job.templateId },
			expiresAt: new Date(Date.now() + ttlMs).toISOString(),
			metadata: { requestedBy: job.requestedBy },
			streamMetadata: job.streamMetadata, // Include YouTube stream details
		},
	};
	const ackPromise = new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => {
			pendingAssignAcks.delete(msg.msgId);
			resolve(false);
		}, ttlMs);
		pendingAssignAcks.set(msg.msgId, { resolve, timer });
	});
	agent.ws.send(JSON.stringify(msg));
	const accepted = await ackPromise;
	return accepted;
}

async function schedule() {
	if (scheduling) return;
	scheduling = true;
	try {
		// Find first PENDING job
		const pending = Array.from(jobs.values()).find((j) => j.status === "PENDING");
		if (!pending) return;

		// Find an IDLE non-draining agent
		const idle = Array.from(agents.values()).find((a) => a.state === "IDLE" && !a.drain && a.ws);
		if (!idle) return;

		// Reserve agent and assign
		setAgentState(idle, "RESERVED");
		updateJob(pending.id, { status: "ASSIGNED", agentId: idle.id });

		console.log(`Assigning job ${pending.id} to agent ${idle.id}`);
		console.log(`Job status: ${pending.status}`);
		console.log(`Job has streamMetadata: ${!!pending.streamMetadata}`);
		console.log(`Job stream metadata:`, JSON.stringify(pending.streamMetadata, null, 2));

		const accepted = await sendAssignAndAwaitAck(idle, pending, 5000);

		if (!accepted) {
			// Revert
			updateJob(pending.id, { status: "PENDING", agentId: null });
			setAgentState(idle, "IDLE");
			return;
		}

		// Move to STARTING on both sides
		idle.currentJobId = pending.id;
		setAgentState(idle, "STARTING");
		updateJob(pending.id, { status: "ACCEPTED" });
	} finally {
		scheduling = false;
	}
}

async function monitorStreamHealth() {
	if (monitoring) return;
	monitoring = true;
	try {
		const now = Date.now();
		const candidates = Array.from(jobs.values()).filter((j) => j.status === "RUNNING");

		for (const job of candidates) {
			const youtube = job.streamMetadata?.youtube;
			if (!youtube?.broadcastId || !youtube?.streamId) continue;
			if (job.streamMetadata?.isPaused) continue;
			if (pendingRestarts.has(job.id)) continue;

			let status;
			try {
				status = await youtubeService.getBroadcastAndStreamStatus(youtube.broadcastId, youtube.streamId);
			} catch (error) {
				console.error(`Stream health check failed for job ${job.id}:`, error);
				continue;
			}

			const lifeCycleStatus = status.lifeCycleStatus;
			const streamStatus = status.streamStatus;
			const ended = !!status.actualEndTime || lifeCycleStatus === "complete";
			const inactive = streamStatus && streamStatus !== "active";

			const health = streamHealth.get(job.id) ?? { attempts: 0 };
			if (!ended && !inactive) {
				health.firstInactiveAt = undefined;
				health.nextRestartAt = undefined;
				streamHealth.set(job.id, health);
				continue;
			}

			if (!health.firstInactiveAt) {
				health.firstInactiveAt = now;
				streamHealth.set(job.id, health);
				continue;
			}

			if (now - health.firstInactiveAt < STREAM_INACTIVE_GRACE_MS) {
				streamHealth.set(job.id, health);
				continue;
			}

			if (health.attempts >= STREAM_RESTART_BACKOFFS_MS.length) {
				const agent = job.agentId ? agents.get(job.agentId) : null;
				if (agent?.ws) {
					const msg: WSMessage = {
						type: Msg.OrchestratorJobStop,
						msgId: randomUUID(),
						ts: new Date().toISOString(),
						payload: { jobId: job.id, reason: "restart attempts exhausted", deadlineMs: STOP_GRACE_MS },
					};
					agent.ws.send(JSON.stringify(msg));
				}

				updateJob(job.id, {
					status: "FAILED",
					endedAt: new Date().toISOString(),
					error: { code: "STREAM_RESTART_EXCEEDED", message: "Stream restart attempts exhausted" },
				});
				void endBroadcastForJob(job, "restart attempts exhausted");
				emitJobEvent(job.id, "stream.restart_exhausted", "Stream restart attempts exhausted", {
					lifeCycleStatus,
					streamStatus,
				});
				streamHealth.delete(job.id);
				continue;
			}

			if (health.nextRestartAt && now < health.nextRestartAt) {
				streamHealth.set(job.id, health);
				continue;
			}

			health.attempts += 1;
			const backoffMs = STREAM_RESTART_BACKOFFS_MS[health.attempts - 1];
			health.nextRestartAt = now + backoffMs;
			streamHealth.set(job.id, health);

			await queueStreamRestart(job, "stream monitor restart", {
				attempt: health.attempts,
				backoffMs,
				lifeCycleStatus,
				streamStatus,
			});
		}
	} finally {
		monitoring = false;
	}
}

// Stream title and description generation functions
function generateStreamTitle(context: StreamContext): string {
	const parts: string[] = [];

	// Add context name (strip extra info like " - Fall 2025")
	if (context.context) {
		// Split on " - " and take only the first portion to remove season/year info
		const cleanContext = context.context.split(' - ')[0].trim();
		parts.push(cleanContext);
	} else {
		parts.push('Triangle Curling');
	}

	// Get date (used in both formats)
	const now = new Date();
	const month = now.getMonth() + 1;
	const day = now.getDate();
	const year = now.getFullYear();

	// Check if team names are populated (and not vibe stream)
	const hasTeamNames = context.sheet !== 'vibe' && context.team1 && context.team2;

	if (hasTeamNames) {
		// Format with team names: <Context> - <Sheet letter>: <Red team name> v. <Yellow team name> - <mm/dd/yyyy>
		parts.push(`${context.sheet}: ${context.team1} v. ${context.team2}`);
		parts.push(`${month}/${day}/${year}`);
	} else {
		// Format without team names: <Context> - Sheet <Sheet letter> - <mm/dd/yyyy> <h:mm AM/PM>
		// Add sheet identifier
		if (context.sheet) {
			if (context.sheet === 'vibe') {
				parts.push('Vibe Stream');
			} else {
				parts.push(`Sheet ${context.sheet}`);
			}
		} else {
			parts.push('Live Stream');
		}

		// Add date and time
		const timeString = now.toLocaleString('en-US', {
			hour: 'numeric',
			minute: '2-digit',
			hour12: true
		});
		parts.push(`${month}/${day}/${year} ${timeString}`);
	}

	return parts.join(' - ');
}

function generateStreamDescription(context: StreamContext): string {
	return 'To watch other sheets, visit https://www.youtube.com/@TriangleCurling/streams';
}

// Kick scheduler periodically
setInterval(() => {
	void schedule();
}, 500);

setInterval(() => {
	void monitorStreamHealth();
}, STREAM_HEALTH_INTERVAL_MS);

/**
 * Start server
 */
async function startServer() {
	await setupApp();

	app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
		console.log(`Orchestrator listening on http://localhost:${PORT}`);
		console.log(`- Agent WS:  ws://localhost:${PORT}/agent`);
		console.log(`- UI WS:     ws://localhost:${PORT}/ui`);
		console.log(`- Status WS: ws://localhost:${PORT}/status-ws (public)`);
		console.log(`- Status HTTP: http://localhost:${PORT}/status (public)`);
	});
}

startServer().catch(console.error);
