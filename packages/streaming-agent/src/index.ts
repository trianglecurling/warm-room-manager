import "dotenv/config";
import { WebSocket } from "ws";
import { hostname } from "os";
import { randomUUID } from "crypto";
import { WSMessage, Msg, JobStatus, AgentState, StreamMetadata } from "@warm-room-manager/shared";
import { OBSManager } from "./obs-manager";

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL ?? "ws://localhost:8080/agent";
const AGENT_TOKEN = process.env.AGENT_TOKEN ?? "dev-shared-token";
let AGENT_ID = process.env.AGENT_ID || `agent-${hostname()}`;
// Ensure we never have a simple numeric ID that could conflict
if (/^\d+$/.test(AGENT_ID)) {
    AGENT_ID = `agent-${hostname()}`;
}
const AGENT_NAME = process.env.AGENT_NAME || hostname();
const VERSION = "0.1.0";

console.log(`Agent starting with ID: ${AGENT_ID}, Name: ${AGENT_NAME}, Hostname: ${hostname()}`);
console.log(`AGENT_ID env var: ${process.env.AGENT_ID ? `"${process.env.AGENT_ID}"` : 'not set'}`);
console.log(`AGENT_NAME env var: ${process.env.AGENT_NAME ? `"${process.env.AGENT_NAME}"` : 'not set'}`);

let ws: WebSocket | null = null;
let state: AgentState = "OFFLINE";
let currentJobId: string | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let heartbeatIntervalMs = 3000;
let obsManager: OBSManager | null = null;
let isConnecting = false; // Prevent multiple simultaneous connection attempts
let currentStreamConfig: { streamUrl: string; streamKey: string } | null = null;
let isPaused = false;
let streamFailureReported = false; // Guard against duplicate failure reports

async function onStreamFailure(jobId: string, reason: 'obs' | 'ffmpeg') {
	if (currentJobId !== jobId || streamFailureReported) return;
	streamFailureReported = true;

	const errorCode = reason === 'obs' ? 'OBS_CRASHED' : 'FFMPEG_EXITED';
	console.error(`🚨 Stream failure detected (${reason}) for job ${jobId} - reporting for auto-recovery`);

	try {
		// Clean up without full stopStreaming (which would clear onStreamFailure - already done by OBS)
		if (obsManager) {
			try {
				await obsManager.stopFFmpegStream();
			} catch (e) {
				console.warn('Error stopping FFmpeg during failure cleanup:', e);
			}
		}
	} finally {
		currentJobId = null;
		currentStreamConfig = null;
		isPaused = false;
		state = "IDLE";

		send(Msg.AgentJobStopped, {
			jobId,
			status: "FAILED" as const,
			error: {
				code: errorCode,
				message: reason === 'obs' ? 'OBS exited unexpectedly' : 'FFmpeg exited unexpectedly'
			}
		});
	}
}

function connect() {
	// Prevent multiple simultaneous connection attempts
	if (isConnecting) {
		console.log(`Connection attempt already in progress, skipping...`);
		return;
	}
	
	// If already connected, don't reconnect
	if (ws && ws.readyState === WebSocket.OPEN) {
		console.log(`Already connected, skipping reconnect`);
		return;
	}
	
	isConnecting = true;
	console.log(`Agent ${AGENT_NAME} connecting to ${ORCHESTRATOR_URL}...`);

	// Initialize OBS Manager
	obsManager = new OBSManager();

	const currentWs = new WebSocket(ORCHESTRATOR_URL);
	ws = currentWs; // Update module-level reference

	currentWs.on("open", () => {
		// Only handle if this is still the active WebSocket
		if (ws !== currentWs) {
			console.log(`Ignoring open event from old WebSocket`);
			return;
		}
		isConnecting = false; // Connection established
		state = "IDLE";
		const hello: WSMessage = {
			type: Msg.AgentHello,
			msgId: randomUUID(),
			ts: new Date().toISOString(),
			agentId: AGENT_ID,
			payload: {
				agentId: AGENT_ID,
				name: AGENT_NAME,
				version: VERSION,
				capabilities: { slots: 1 },
				drain: false,
				activeJob: currentJobId ? { jobId: currentJobId, status: "RUNNING" as JobStatus } : null,
				auth: { token: AGENT_TOKEN },
			},
		};
		currentWs.send(JSON.stringify(hello));
	});

	currentWs.on("message", (raw) => {
		// Only handle if this is still the active WebSocket
		if (ws !== currentWs) {
			return;
		}
		let msg: WSMessage<any>;
		try {
			msg = JSON.parse(String(raw));
		} catch {
			return;
		}

		switch (msg.type) {
			case Msg.OrchestratorHelloOk: {
				const p = msg.payload as {
					heartbeatIntervalMs: number;
					heartbeatTimeoutMs: number;
					stopGraceMs: number;
					killAfterMs: number;
				};
				heartbeatIntervalMs = p.heartbeatIntervalMs;
				startHeartbeat();
				break;
			}
			case Msg.OrchestratorAssignStart: {
				onAssignStart(msg);
				break;
			}
			case Msg.OrchestratorJobStop: {
				onJobStop(msg);
				break;
			}
			case Msg.OrchestratorJobMute: {
				onJobMute(msg);
				break;
			}
			case Msg.OrchestratorJobUnmute: {
				onJobUnmute(msg);
				break;
			}
			case Msg.OrchestratorJobPause: {
				onJobPause(msg);
				break;
			}
			case Msg.OrchestratorJobUnpause: {
				onJobUnpause(msg);
				break;
			}
			default:
				break;
		}
	});

	currentWs.on("close", async (code, reason) => {
		// Only handle this close event if this WebSocket is still the active one
		// This prevents old WebSocket close events from triggering reconnects
		if (ws !== currentWs) {
			console.log(`Ignoring close event from old WebSocket (new connection active)`);
			return;
		}
		
		isConnecting = false; // Connection attempt finished (failed)
		console.log(`Connection closed. Code: ${code}, Reason: ${reason?.toString() || 'No reason'}. Reconnecting in 3s...`);
		stopHeartbeat();
		state = "OFFLINE";
		ws = null; // Clear WebSocket reference

		// Clean up OBS processes
		if (obsManager) {
			try {
				await obsManager.disconnect();
			} catch (error) {
				console.error('Error cleaning up OBS on disconnect:', error);
			}
		}

		// Reconnect after delay
		setTimeout(() => {
			// Double-check we're still disconnected before reconnecting
			if (!ws || ws.readyState !== WebSocket.OPEN) {
				connect();
			} else {
				console.log(`Skipping reconnect - connection already established`);
			}
		}, 3000);
	});

	currentWs.on("error", (err) => {
		// Only handle if this is still the active WebSocket
		if (ws !== currentWs) {
			return;
		}
		isConnecting = false; // Connection attempt failed
		console.error("WS error:", err);
	});
}

function send<T = unknown>(type: string, payload: T, correlationId?: string) {
	if (!ws || ws.readyState !== WebSocket.OPEN) return;
	const msg: WSMessage<T> = {
		type,
		msgId: randomUUID(),
		correlationId: correlationId ?? null,
		ts: new Date().toISOString(),
		agentId: AGENT_ID,
		payload,
	};
	ws.send(JSON.stringify(msg));
}

function startHeartbeat() {
	stopHeartbeat();
	heartbeatTimer = setInterval(() => {
		send(Msg.AgentHeartbeat, {
			metrics: {},
		});
	}, heartbeatIntervalMs);
}

function stopHeartbeat() {
	if (heartbeatTimer) clearInterval(heartbeatTimer);
	heartbeatTimer = null;
}

// Real OBS and FFmpeg streaming
async function startStreamingJob(jobId: string, config: any, streamMetadata?: StreamMetadata) {
	try {
		console.log(`Starting streaming job ${jobId}`);
		console.log(`Stream metadata received:`, JSON.stringify(streamMetadata, null, 2));

		if (!obsManager) {
			throw new Error('OBS Manager not initialized');
		}

		if (!streamMetadata?.youtube?.streamUrl || !streamMetadata?.youtube?.streamKey) {
			console.error('Missing YouTube stream configuration for FFmpeg:', {
				hasStreamMetadata: !!streamMetadata,
				hasYoutube: !!streamMetadata?.youtube,
				streamUrl: streamMetadata?.youtube?.streamUrl,
				streamKey: streamMetadata?.youtube?.streamKey
			});
			throw new Error('Missing YouTube stream configuration for FFmpeg');
		}

		currentStreamConfig = {
			streamUrl: streamMetadata.youtube.streamUrl,
			streamKey: streamMetadata.youtube.streamKey,
		};
		isPaused = false;
		streamFailureReported = false;

		// Determine scene name from stream key
		let sceneName = 'SheetA'; // Default scene
		const streamKey = config?.streamKey;
		console.log('🎭 Determining scene from streamKey:', streamKey);

		if (streamKey) {
			// Extract scene info from stream key (e.g., "sheetA", "sheetB", "sheetD", "vibe")
			const lowerKey = streamKey.toLowerCase();
			console.log('📄 Processing stream key:', lowerKey);

			if (lowerKey === 'vibe') {
				sceneName = 'IceShedVibes';
				console.log('🎵 Mapped vibe to IceShedVibes');
			} else if (lowerKey.startsWith('sheet')) {
				// Extract letter from "sheetA", "sheetB", etc.
				const sheetLetter = lowerKey.replace('sheet', '').toUpperCase();
				console.log('📝 Extracted sheet letter:', sheetLetter);

				if (['A', 'B', 'C', 'D'].includes(sheetLetter)) {
					if (sheetLetter === 'A') sceneName = 'SheetA';
					else if (sheetLetter === 'B') sceneName = 'SheetB';
					else if (sheetLetter === 'C') sceneName = 'SheetC';
					else if (sheetLetter === 'D') sceneName = 'SheetD';
					console.log(`🎯 Mapped ${streamKey} to ${sceneName}`);
				} else {
					console.log(`⚠️ Unknown sheet letter: ${sheetLetter}, using default SheetA`);
				}
			} else {
				console.log(`⚠️ Unknown stream key format: ${streamKey}, using default SheetA`);
			}
		} else {
			console.log('⚠️ No streamKey found, using default SheetA');
		}

		console.log('🎬 Final scene name:', sceneName);

		// Start streaming to YouTube (OBS will be started automatically with correct scene)
		await obsManager.startStreaming(
			{
				streamUrl: streamMetadata.youtube.streamUrl,
				streamKey: streamMetadata.youtube.streamKey
			},
			sceneName,
			(reason) => onStreamFailure(jobId, reason)
		);

		console.log(`Streaming job ${jobId} started successfully (OBS Virtual Camera + FFmpeg)`);
		state = "RUNNING";
		send(Msg.AgentJobUpdate, { jobId, status: "RUNNING" as JobStatus });

	} catch (error) {
		console.error(`Failed to start streaming job ${jobId}:`, error);
		state = "IDLE";
		currentJobId = null;
		send(Msg.AgentJobStopped, {
			jobId,
			status: "FAILED" as const,
			error: {
				code: "STREAMING_FAILED",
				message: error instanceof Error ? error.message : "Unknown error"
			}
		});
	}
}

async function stopStreamingJob(jobId: string, reason?: string) {
	try {
		console.log(`Stopping streaming job ${jobId}. Reason: ${reason ?? "n/a"}`);

		if (obsManager) {
			await obsManager.stopStreaming();
			await obsManager.stopFFmpegStream();
		}

		isPaused = false;
		currentStreamConfig = null;
		currentJobId = null;
		streamFailureReported = false;
		state = "IDLE";
		send(Msg.AgentJobStopped, { jobId, status: "STOPPED" as const });

	} catch (error) {
		console.error(`Error stopping streaming job ${jobId}:`, error);
		currentJobId = null;
		state = "IDLE";
		send(Msg.AgentJobStopped, {
			jobId,
			status: "FAILED" as const,
			error: {
				code: "STOP_FAILED",
				message: error instanceof Error ? error.message : "Unknown error"
			}
		});
	}
}

function onAssignStart(
	msg: WSMessage<{
		jobId: string;
		idempotencyKey: string;
		config: unknown;
		expiresAt: string;
		metadata?: Record<string, unknown>;
		streamMetadata?: StreamMetadata;
	}>
) {
	const { jobId, config, streamMetadata } = msg.payload;

	console.log(`Received job assignment for ${jobId}`);
	console.log(`Assignment payload:`, JSON.stringify(msg.payload, null, 2));

	if (state !== "IDLE" || currentJobId) {
		send(Msg.AgentAssignAck, { jobId, accepted: false, reason: "busy" }, msg.msgId);
		return;
	}

	currentJobId = jobId;
	state = "STARTING";
	send(Msg.AgentAssignAck, { jobId, accepted: true }, msg.msgId);

	// Start streaming job asynchronously
	startStreamingJob(jobId, config, streamMetadata);
}

function onJobStop(msg: WSMessage<{ jobId: string; reason?: string; deadlineMs?: number }>) {
	const { jobId, reason } = msg.payload;
	if (!currentJobId || currentJobId !== jobId) return;
	stopStreamingJob(jobId, reason);
}

async function onJobMute(msg: WSMessage<{ jobId: string }>) {
	const { jobId } = msg.payload;
	if (!currentJobId || currentJobId !== jobId) return;

	try {
		console.log(`Muting audio for job ${jobId}`);

		if (obsManager) {
			await obsManager.muteAudio();
		}

		// Send acknowledgment back to orchestrator
		send(Msg.AgentJobMute, { jobId, success: true });
	} catch (error) {
		console.error(`Failed to mute job ${jobId}:`, error);
		send(Msg.AgentJobMute, { jobId, success: false });
	}
}

async function onJobUnmute(msg: WSMessage<{ jobId: string }>) {
	const { jobId } = msg.payload;
	if (!currentJobId || currentJobId !== jobId) return;

	try {
		console.log(`Unmuting audio for job ${jobId}`);

		if (obsManager) {
			await obsManager.unmuteAudio();
		}

		// Send acknowledgment back to orchestrator
		send(Msg.AgentJobUnmute, { jobId, success: true });
	} catch (error) {
		console.error(`Failed to unmute job ${jobId}:`, error);
		send(Msg.AgentJobUnmute, { jobId, success: false });
	}
}

async function onJobPause(msg: WSMessage<{ jobId: string }>) {
	const { jobId } = msg.payload;
	if (!currentJobId || currentJobId !== jobId) return;

	try {
		if (isPaused) {
			send(Msg.AgentJobPaused, { jobId, success: true });
			return;
		}

		console.log(`Pausing stream for job ${jobId}`);

		if (obsManager) {
			await obsManager.stopFFmpegStream();
		}

		isPaused = true;
		send(Msg.AgentJobPaused, { jobId, success: true });
	} catch (error) {
		console.error(`Failed to pause job ${jobId}:`, error);
		send(Msg.AgentJobPaused, { jobId, success: false });
	}
}

async function onJobUnpause(msg: WSMessage<{ jobId: string }>) {
	const { jobId } = msg.payload;
	if (!currentJobId || currentJobId !== jobId) return;

	try {
		if (!isPaused) {
			send(Msg.AgentJobUnpaused, { jobId, success: true });
			return;
		}

		console.log(`Unpausing stream for job ${jobId}`);

		if (!currentStreamConfig) {
			throw new Error('Missing stream configuration for unpause');
		}

		if (obsManager) {
			await obsManager.startFFmpegStream(currentStreamConfig);
		}

		isPaused = false;
		send(Msg.AgentJobUnpaused, { jobId, success: true });
	} catch (error) {
		console.error(`Failed to unpause job ${jobId}:`, error);
		send(Msg.AgentJobUnpaused, { jobId, success: false });
	}
}

connect();
