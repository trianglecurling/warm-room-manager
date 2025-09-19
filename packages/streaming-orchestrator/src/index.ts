import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { WebSocketServer, WebSocket } from "ws";
import { youtubeService, YouTubeService } from "./youtube-service";
import { randomUUID } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { google } from 'googleapis';
import { AgentInfo, AgentState, Job, JobStatus, WSMessage, Msg, StreamMetadata, StreamContext } from "@warm-room-manager/shared";

/**
 * Configuration
 */
const PORT = Number(process.env.PORT ?? 8080);
const AGENT_TOKEN = process.env.AGENT_TOKEN ?? "dev-shared-token";
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS ?? 3000);
const HEARTBEAT_TIMEOUT_MS = Number(process.env.HEARTBEAT_TIMEOUT_MS ?? 10000);
const STOP_GRACE_MS = Number(process.env.STOP_GRACE_MS ?? 10000);
const KILL_AFTER_MS = Number(process.env.KILL_AFTER_MS ?? 5000);

/**
 * In-memory stores (replace with SQLite later)
 */
type AgentNode = AgentInfo & {
	ws?: WebSocket;
	timers: {
		heartbeatTimeout?: NodeJS.Timeout;
	};
};

const agents = new Map<string, AgentNode>();
const jobs = new Map<string, Job>();
const pendingByIdem = new Map<string, string>(); // idemKey -> jobId

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
	return job;
}

function updateJob(id: string, patch: Partial<Job>) {
	const j = jobs.get(id);
	if (!j) return;
	Object.assign(j, patch, { updatedAt: new Date().toISOString() });
	jobs.set(id, j);
	broadcastUI(Msg.UIJobUpdate, j);
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
}

app.get("/healthz", async () => ({ ok: true }));

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

		// Update environment variable (in a real app, you'd save to database)
		if (tokens.refresh_token) {
			process.env.YOUTUBE_REFRESH_TOKEN = tokens.refresh_token;
		}

		// Save to .env file
		try {
			let envContent = '';
			try {
				envContent = readFileSync('.env', 'utf8');
			} catch (e) {
				// .env doesn't exist, create new one
			}

			const lines = envContent.split('\n');
			let found = false;
			const updatedLines = lines.map(line => {
				if (line.startsWith('YOUTUBE_REFRESH_TOKEN=')) {
					found = true;
					return `YOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}`;
				}
				return line;
			});

			if (!found) {
				updatedLines.push(`YOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}`);
			}

			writeFileSync('.env', updatedLines.join('\n'));
		} catch (error) {
			console.warn('Could not save refresh token to .env file:', error);
		}

		return {
			success: true,
			message: 'OAuth2 token updated successfully',
			refreshToken: tokens.refresh_token ? 'saved' : 'not_provided'
		};
	} catch (error) {
		throw new Error(`Failed to exchange authorization code: ${error instanceof Error ? error.message : 'Unknown error'}`);
	}
});

app.delete("/oauth/token", async () => {
	// Clear the refresh token
	delete process.env.YOUTUBE_REFRESH_TOKEN;

	// Remove from .env file
	try {
		let envContent = '';
		try {
			envContent = readFileSync('.env', 'utf8');
		} catch (e) {
			return { success: true, message: 'OAuth2 token cleared (no .env file found)' };
		}

		const lines = envContent.split('\n');
		const updatedLines = lines.filter(line => !line.startsWith('YOUTUBE_REFRESH_TOKEN='));

		writeFileSync('.env', updatedLines.join('\n'));
	} catch (error) {
		console.warn('Could not remove refresh token from .env file:', error);
	}

	return { success: true, message: 'OAuth2 token cleared successfully' };
});

app.get("/oauth/callback", async (req, reply) => {
	const { code, error } = req.query as { code?: string; error?: string };

	if (error) {
		// Handle OAuth error
		return reply.redirect(`http://localhost:5173/oauth?error=${encodeURIComponent(error)}`);
	}

	if (!code) {
		return reply.redirect(`http://localhost:5173/oauth?error=no_code`);
	}

	// Redirect back to frontend with the authorization code
	return reply.redirect(`http://localhost:5173/oauth?code=${encodeURIComponent(code)}`);
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
	const { templateId, inlineConfig, idempotencyKey, restartPolicy, streamContext } = req.body;

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

		if (streamContext) {
			// Generate title based on stream context
			title = generateStreamTitle(streamContext);
			description = generateStreamDescription(streamContext);
		} else {
			// Fallback to default titles
			title = YouTubeService.generateStreamTitle();
			description = YouTubeService.generateStreamDescription();
		}

		const youtubeMetadata = await youtubeService.createLiveBroadcast(title, description);

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
			publicUrl: `https://youtube.com/watch?v=${youtubeMetadata.videoId}`,
			adminUrl: `https://studio.youtube.com/video/${youtubeMetadata.videoId}/livestreaming`,
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
	return reply.code(200).send({ ok: true, metadata: updatedMetadata });
});

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

/**
 * WebSocket servers
 */
const server = app.server as unknown as import("http").Server;

const wssAgents = new WebSocketServer({ noServer: true });
const wssUi = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
	const { url } = req;
	if (url?.startsWith("/agent")) {
		wssAgents.handleUpgrade(req, socket, head, (ws) => {
			wssAgents.emit("connection", ws, req);
		});
	} else if (url?.startsWith("/ui")) {
		wssUi.handleUpgrade(req, socket, head, (ws) => {
			wssUi.emit("connection", ws, req);
		});
	} else {
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

/**
 * Agent protocol handling
 */
type PendingAck = {
	resolve: (ok: boolean) => void;
	timer: NodeJS.Timeout;
};
const pendingAssignAcks = new Map<string, PendingAck>(); // correlationId -> waiter

wssAgents.on("connection", (ws) => {
	let attachedAgentId: string | null = null;

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
				ws.close(4001, "Unauthorized");
				return;
			}

			let agent = agents.get(agentId);
			if (!agent) {
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
					timers: {},
				};
				agents.set(agentId, agent);
			} else {
				// Check if the existing agent is still connected
				if (agent.ws && agent.ws.readyState === WebSocket.OPEN && agent.state !== "OFFLINE") {
					console.warn(`Rejecting duplicate agent connection for ID ${agentId} from ${name}`);
					ws.close(4002, "Agent ID already in use by another active agent");
					return;
				}
			}
			agent.ws = ws;
			agent.name = name;
			agent.version = version;
			agent.capabilities = capabilities;
			agent.drain = !!drain;
			agent.lastSeenAt = new Date().toISOString();
			attachedAgentId = agentId;

			setAgentState(agent, agent.state === "OFFLINE" ? "IDLE" : agent.state);

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
					updateJob(jobId, {
						status,
						endedAt: new Date().toISOString(),
						error: error ?? null,
					});
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
			default:
				break;
		}
	});

	ws.on("close", () => {
		if (!attachedAgentId) return;
		const agent = agents.get(attachedAgentId);
		if (!agent) return;
		setAgentState(agent, "OFFLINE");
	});
});

/**
 * Scheduler
 */
let scheduling = false;

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

// Stream title and description generation functions
function generateStreamTitle(context: StreamContext): string {
	const parts: string[] = [];

	// Add context
	if (context.context) {
		parts.push(context.context);
	}

	// Add draw number (optional)
	if (context.drawNumber) {
		parts.push(`Draw ${context.drawNumber}`);
	}

	// Add sheet identifier
	if (context.sheet) {
		if (context.sheet === 'vibe') {
			parts.push('Vibe Stream');
		} else {
			parts.push(`Sheet ${context.sheet}`);
		}
	}

	// Add teams (if both are provided)
	if (context.team1 && context.team2) {
		parts.push(`(${context.team1} v. ${context.team2})`);
	}

	// Add today's date
	const today = new Date();
	const formattedDate = `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`;
	parts.push(formattedDate);

	return parts.join(' - ');
}

function generateStreamDescription(context: StreamContext): string {
	let description = 'This is an automated live stream created by the Stream Control system.';

	if (context.context) {
		description += ` Streaming ${context.context.toLowerCase()}.`;
	}

	if (context.team1 && context.team2) {
		description += ` Watch ${context.team1} vs ${context.team2} live!`;
	}

	if (context.sheet) {
		if (context.sheet === 'vibe') {
			description += ' Tune in for the vibe stream experience.';
		} else {
			description += ` Catch all the action from Sheet ${context.sheet}.`;
		}
	}

	description += ' Join us for an exciting broadcast!';

	return description;
}

// Kick scheduler periodically
setInterval(() => {
	void schedule();
}, 500);

/**
 * Start server
 */
async function startServer() {
	await setupApp();

	app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
		console.log(`Orchestrator listening on http://localhost:${PORT}`);
		console.log(`- Agent WS: ws://localhost:${PORT}/agent`);
		console.log(`- UI WS:    ws://localhost:${PORT}/ui`);
	});
}

startServer().catch(console.error);
