import { OBSWebSocket } from 'obs-websocket-js';
import { ChildProcess } from 'child_process';
import { Socket } from 'net';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';

export interface OBSConfig {
	host: string;
	port: number;
	password?: string;
}

export interface StreamConfig {
	streamUrl: string;
	streamKey: string;
}

export type StreamFailureReason = 'obs' | 'ffmpeg';

class OBSManagerError extends Error {
	code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = 'OBSManagerError';
		this.code = code;
	}
}

export class OBSManager {
	private obs: OBSWebSocket;
	private config: OBSConfig;
	private ffmpegProcess: ChildProcess | null = null;
	private isConnected = false;
	private currentScene = 'SheetA';
	private startOBSPromise: Promise<void> | null = null;
	private launchedObsPid: number | null = null;
	private ownsOBSProcess = false;
	private recoveringObsDisconnect = false;
	/** Called when OBS or FFmpeg fails unexpectedly during active streaming. Cleared on stopStreaming. */
	private onStreamFailure?: (reason: StreamFailureReason) => void;

	private getStreamingProfile() {
		const profile = {
			videoCodec: process.env.FFMPEG_VIDEO_CODEC || 'hevc_amf',
			videoRateControl: process.env.FFMPEG_VIDEO_RATE_CONTROL || 'cqp',
			videoQ: process.env.FFMPEG_VIDEO_Q || '20',
			videoBitrate: process.env.FFMPEG_VIDEO_BITRATE || '15000k',
			videoMaxrate: process.env.FFMPEG_VIDEO_MAXRATE || '20000k',
			videoBufsize: process.env.FFMPEG_VIDEO_BUFSIZE || '45000k',
			audioBitrate: process.env.FFMPEG_AUDIO_BITRATE || '128k',
			fps: process.env.FFMPEG_FPS || '30',
			gop: process.env.FFMPEG_GOP || '60',
			videoFilter: process.env.FFMPEG_VIDEO_FILTER || 'scale=1920:1080,format=yuv420p',
			videoInputBuffer: process.env.FFMPEG_VIDEO_INPUT_RTBUFSIZE || '1000M',
			audioInputBuffer: process.env.FFMPEG_AUDIO_INPUT_RTBUFSIZE || '100M',
			videoThreadQueue: process.env.FFMPEG_VIDEO_THREAD_QUEUE_SIZE || '2048',
			audioThreadQueue: process.env.FFMPEG_AUDIO_THREAD_QUEUE_SIZE || '512',
		};
		return profile;
	}

	/**
	 * Get the correct audio source for the current scene
	 */
	private getAudioSourceForScene(): string {
		let audioSource: string;

		switch (this.currentScene) {
			case 'SheetA':
				audioSource = 'DVS Receive  1-2 (Dante Virtual Soundcard)';
				break;
			case 'SheetB':
				audioSource = 'DVS Receive  3-4 (Dante Virtual Soundcard)';
				break;
			case 'SheetC':
				audioSource = 'DVS Receive  5-6 (Dante Virtual Soundcard)';
				break;
			case 'SheetD':
				audioSource = 'DVS Receive  7-8 (Dante Virtual Soundcard)';
				break;
			case 'IceShedVibes':
				audioSource = 'DVS Receive  9-10 (Dante Virtual Soundcard)';
				break;
			default:
				console.warn(`Unknown scene: ${this.currentScene}, defaulting to VibeStream audio`);
				audioSource = 'DVS Receive  9-10 (Dante Virtual Soundcard)';
				break;
		}

		console.log(`🎵 Audio source mapping for ${this.currentScene}: ${audioSource}`);
		return audioSource;
	}

	constructor(config: OBSConfig = { host: 'localhost', port: 4455 }) {
		this.config = config;
		this.obs = new OBSWebSocket();
		console.log(`OBS connection config: host=${this.config.host}, port=${this.config.port}, password=${this.config.password ? '[set]' : '[not set]'}`);

		this.obs.on('ConnectionOpened', () => {
			console.log('OBS WebSocket connected');
			this.isConnected = true;
		});

		this.obs.on('ConnectionClosed', () => {
			console.log('OBS WebSocket disconnected');
			this.isConnected = false;
			// If we're actively streaming, try quick reconnect before failing the stream.
			if (this.onStreamFailure && this.ffmpegProcess && !this.recoveringObsDisconnect) {
				this.recoveringObsDisconnect = true;
				void (async () => {
					try {
						console.warn('🚨 OBS disconnected during stream - attempting reconnect');
						await this.connectWithRetry(3, 1000);
						console.log('✅ OBS WebSocket reconnected after transient disconnect');
					} catch {
						console.warn('🚨 OBS reconnect failed - triggering stream recovery');
						this.onStreamFailure?.('obs');
					} finally {
						this.recoveringObsDisconnect = false;
					}
				})();
			}
		});

		this.obs.on('ConnectionError', (error) => {
			console.error('OBS WebSocket error:', error);
		});
	}

	async connect(): Promise<void> {
		try {
			const endpoint = `ws://${this.config.host}:${this.config.port}`;
			await this.obs.connect(endpoint, this.config.password);
			console.log('OBS WebSocket connected successfully');
		} catch (error) {
			console.error('Failed to connect to OBS:', error);
			throw error;
		}
	}

	async connectWithRetry(maxRetries = 10, retryInterval = 1000): Promise<void> {
		console.log(`Attempting to connect to OBS WebSocket (will retry up to ${maxRetries} times)...`);

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				await this.connect();
				console.log(`✅ OBS WebSocket connected successfully on attempt ${attempt}`);
				return; // Success, exit the retry loop
			} catch (error) {
				const errorCode = (error as any)?.code ? ` [code ${(error as any).code}]` : '';
				const rawMessage = error instanceof Error ? error.message : String(error);
				const errorMessage = (rawMessage && rawMessage.trim()) ? rawMessage : 'No error message provided by OBS';
				console.warn(`WebSocket connection attempt ${attempt}/${maxRetries} failed:`, errorMessage);

				if (attempt === maxRetries) {
					// This was the last attempt, throw the error
					throw new Error(`Failed to connect to OBS WebSocket after ${maxRetries} attempts: ${errorMessage}${errorCode}`);
				}

				// Wait before retrying
				console.log(`Waiting ${retryInterval}ms before retry...`);
				await new Promise(resolve => setTimeout(resolve, retryInterval));
			}
		}
	}

	private classifyOBSConnectionError(message: string): 'auth' | 'refused' | 'timeout' | 'other' {
		const lower = message.toLowerCase();
		if (
			lower.includes('authentication') ||
			lower.includes('auth failed') ||
			lower.includes('invalid password') ||
			lower.includes('identify')
		) {
			return 'auth';
		}
		if (lower.includes('econnrefused') || lower.includes('connection refused')) {
			return 'refused';
		}
		if (lower.includes('etimedout') || lower.includes('timeout')) {
			return 'timeout';
		}
		return 'other';
	}

	private getAttachErrorCode(errorKind: 'auth' | 'refused' | 'timeout' | 'other', portReachable: boolean): string {
		if (errorKind === 'auth') return 'OBS_WS_AUTH_MISMATCH';
		if (!portReachable || errorKind === 'refused' || errorKind === 'timeout') return 'OBS_WS_PORT_UNREACHABLE';
		return 'OBS_WS_ATTACH_FAILED';
	}

	private async isOBSWebSocketPortReachable(timeoutMs = 1200): Promise<boolean> {
		return await new Promise((resolve) => {
			const socket = new Socket();
			const cleanup = () => {
				socket.removeAllListeners();
				socket.destroy();
			};
			socket.setTimeout(timeoutMs);
			socket.once('connect', () => {
				cleanup();
				resolve(true);
			});
			socket.once('timeout', () => {
				cleanup();
				resolve(false);
			});
			socket.once('error', () => {
				cleanup();
				resolve(false);
			});
			socket.connect(this.config.port, this.config.host);
		});
	}

	private async isOBSProcessRunning(): Promise<boolean> {
		const { exec } = require('child_process');
		const { promisify } = require('util');
		const execAsync = promisify(exec);
		try {
			const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq obs64.exe" /FO CSV /NH');
			return !!(stdout && stdout.trim() && !stdout.includes('INFO: No tasks'));
		} catch {
			return false;
		}
	}

	private async ensureVirtualCameraStarted(): Promise<void> {
		if (!this.isConnected) return;
		try {
			const status = await this.obs.call('GetVirtualCamStatus') as { outputActive?: boolean };
			if (status?.outputActive) {
				console.log('Virtual camera already active');
				return;
			}
		} catch {
			// Some OBS versions/plugins may not support status query; fallback to start call below.
		}
		try {
			await this.obs.call('StartVirtualCam');
			console.log('Virtual camera started successfully');
		} catch (error: any) {
			const msg = String(error?.message || error || '');
			const alreadyRunning =
				msg.toLowerCase().includes('already') &&
				msg.toLowerCase().includes('virtual') &&
				msg.toLowerCase().includes('camera');
			const unsupported = error?.code === 501;
			// OBS sometimes returns generic 500 for "already active" or startup race conditions.
			const transient500 = error?.code === 500;
			if (alreadyRunning) {
				console.log('Virtual camera already running');
				return;
			}
			if (unsupported) {
				console.log('StartVirtualCam not supported by this OBS version; relying on OBS launch flags');
				return;
			}
			if (transient500) {
				console.warn('StartVirtualCam returned OBS 500; continuing (virtual camera may already be active):', msg);
				return;
			}
			throw error;
		}
	}

	private async launchOBSProcess(sceneName: string): Promise<void> {
		const obsPath = process.env.OBS_PATH || 'obs64.exe';
		const { spawn } = require('child_process');
		const obsDir = obsPath.includes('\\') ? obsPath.substring(0, obsPath.lastIndexOf('\\')) : process.cwd();
		console.log('OBS working directory:', obsDir);
		this.clearCrashSentinelIfPresent();

		// Deliberately omit --multi to prevent multiple OBS instances.
		const obsArgs = [
			`--websocket_port=${this.config.port}`,
			'--collection', 'auto4k',
			'--scene', sceneName,
			'--minimize-to-tray',
			'--disable-updater',
			'--startvirtualcam'
		];
		if (this.config.password) {
			obsArgs.splice(1, 0, `--websocket_password=${this.config.password}`);
		}

		let obsProcess: ChildProcess;
		try {
			obsProcess = spawn(obsPath, obsArgs, {
				cwd: obsDir,
				detached: true,
				stdio: 'ignore'
			});
		} catch (error: any) {
			throw new OBSManagerError(
				'OBS_LAUNCH_FAILED',
				`Failed to launch OBS process: ${error?.message || String(error)}`
			);
		}

		this.launchedObsPid = obsProcess.pid ?? null;
		this.ownsOBSProcess = true;
		obsProcess.unref();
		if (!this.launchedObsPid) {
			throw new OBSManagerError('OBS_LAUNCH_FAILED', 'Failed to launch OBS process: no process id returned');
		}

		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				resolve();
			}, 700);
			obsProcess.once('error', (error: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(new OBSManagerError('OBS_LAUNCH_FAILED', `Failed to start OBS process: ${error.message}`));
			});
		});

		obsProcess.on('exit', (code: number | null, signal: string | null) => {
			console.log(`OBS process exited with code: ${code}, signal: ${signal}`);
		});
	}

	private clearCrashSentinelIfPresent(): void {
		const appData = process.env.APPDATA;
		if (!appData) return;
		const sentinelPath = join(appData, 'obs-studio', '.sentinel');
		try {
			if (existsSync(sentinelPath)) {
				rmSync(sentinelPath, { recursive: true, force: true });
				console.log('Cleared OBS crash sentinel before launch');
			}
		} catch (error) {
			console.warn('Failed to clear OBS crash sentinel:', error);
		}
	}

	private async terminateOBSProcess(targetPid?: number): Promise<void> {
		const { spawn } = require('child_process');
		const baseArgs = targetPid ? ['/pid', String(targetPid)] : ['/im', 'obs64.exe'];
		// First attempt graceful close (no /f) so OBS can shut down cleanly.
		try {
			spawn('taskkill', [...baseArgs, '/t'], { stdio: 'ignore' });
		} catch {
			// best effort
		}
		await new Promise(resolve => setTimeout(resolve, 2500));
		const stillRunning = await this.isOBSProcessRunning();
		if (!stillRunning) return;
		// Fallback to force kill only if graceful close didn't work.
		try {
			spawn('taskkill', ['/f', ...baseArgs, '/t'], { stdio: 'ignore' });
		} catch {
			// best effort
		}
	}

	private async restartOBSProcess(sceneName: string): Promise<void> {
		console.warn('Attempting hard OBS restart (kill + relaunch) to recover websocket');
		await this.terminateOBSProcess();
		this.launchedObsPid = null;
		this.ownsOBSProcess = false;
		await this.launchOBSProcess(sceneName);
		console.log('Waiting 10 seconds for OBS to initialize after restart...');
		await new Promise(resolve => setTimeout(resolve, 10000));
		await this.connectWithRetry(20, 1000);
		await this.setCurrentScene(sceneName);
		await this.ensureVirtualCameraStarted();
	}

	async disconnect(): Promise<void> {
		if (this.isConnected) {
			await this.obs.disconnect();
		}
		this.cleanup();
	}


	async startOBS(sceneName: string = 'SheetA'): Promise<void> {
		this.currentScene = sceneName;
		console.log('🏁 Ensuring OBS is available with scene:', sceneName);

		if (this.isConnected) {
			await this.setCurrentScene(sceneName);
			await this.ensureVirtualCameraStarted();
			return;
		}

		if (this.startOBSPromise) {
			await this.startOBSPromise;
			// Another caller may have started OBS for a different stream.
			// Re-apply requested scene for this call before continuing.
			if (this.isConnected) {
				await this.setCurrentScene(sceneName);
				await this.ensureVirtualCameraStarted();
			}
			return;
		}

		this.startOBSPromise = (async () => {
			// Fast path: OBS may already be up and just needs websocket attach.
			try {
				await this.connectWithRetry(2, 500);
				console.log('Connected to existing OBS instance');
				this.ownsOBSProcess = false;
				await this.setCurrentScene(sceneName);
				await this.ensureVirtualCameraStarted();
				return;
			} catch {
				// Continue to process checks below.
			}

			const running = await this.isOBSProcessRunning();
			if (running) {
				// Guardrail: do not launch another OBS process when one already exists.
				// This usually means websocket settings are mismatched on the running instance.
				try {
					await this.connectWithRetry(15, 1000);
				} catch (error) {
					// Last-resort recovery for broken OBS websocket state on a running process.
					try {
						await this.restartOBSProcess(sceneName);
						return;
					} catch (restartError) {
						const rawMessage = restartError instanceof Error ? restartError.message : String(restartError);
						const errorKind = this.classifyOBSConnectionError(rawMessage);
						const portReachable = await this.isOBSWebSocketPortReachable();
						const code = this.getAttachErrorCode(errorKind, portReachable);
						let likelyCause = 'OBS WebSocket is configured differently than the agent.';
						if (errorKind === 'auth') {
							likelyCause = 'OBS WebSocket password does not match OBS_PASSWORD.';
						} else if (!portReachable || errorKind === 'refused') {
							likelyCause = 'OBS WebSocket server is disabled or OBS is listening on a different port.';
						}
						const guidance = [
							`OBS process is running, but agent could not attach to ws://${this.config.host}:${this.config.port}.`,
							`Likely cause: ${likelyCause}`,
							`Check OBS > Tools > WebSocket Server Settings and verify port/password match OBS_PORT/OBS_PASSWORD.`,
							`Port reachable from agent: ${portReachable ? 'yes' : 'no'}.`,
							`Last error: ${rawMessage}`,
						].join(' ');
						console.error('OBS attach diagnostic:', {
							host: this.config.host,
							port: this.config.port,
							passwordConfigured: !!this.config.password,
							portReachable,
							errorKind,
							rawMessage,
						});
						throw new OBSManagerError(code, guidance);
					}
				}
				this.ownsOBSProcess = false;
				await this.setCurrentScene(sceneName);
				await this.ensureVirtualCameraStarted();
				return;
			}

			await this.launchOBSProcess(sceneName);

			// Give OBS process time to initialize before websocket retries.
			console.log('Waiting 10 seconds for OBS to initialize...');
			await new Promise(resolve => setTimeout(resolve, 10000));
			try {
				await this.connectWithRetry(20, 1000);
			} catch (error) {
				const rawMessage = error instanceof Error ? error.message : String(error);
				const errorKind = this.classifyOBSConnectionError(rawMessage);
				const portReachable = await this.isOBSWebSocketPortReachable();
				const code = this.getAttachErrorCode(errorKind, portReachable);
				throw new OBSManagerError(
					code,
					`OBS was launched but agent could not connect to ws://${this.config.host}:${this.config.port}. ` +
					`Check OBS WebSocket settings (enabled, port/password). Last error: ${rawMessage}`
				);
			}
			await this.setCurrentScene(sceneName);
			await this.ensureVirtualCameraStarted();
		})().finally(() => {
			this.startOBSPromise = null;
		});

		await this.startOBSPromise;
	}

	async stopOBS(): Promise<void> {
		console.log('Stopping OBS...');

		// Only call cleanup if we're not already in a stopStreaming sequence
		// cleanup() calls stopFFmpegStream() which we may have already called
		try {
			await this.stopFFmpegStream();
		} catch (error) {
			console.warn('Failed to stop FFmpeg in stopOBS, it may already be stopped:', error);
		}

		// Only force-kill OBS if this manager launched it.
		if (this.ownsOBSProcess && this.launchedObsPid) {
			try {
				console.log(`Stopping OBS process PID: ${this.launchedObsPid}`);
				await this.terminateOBSProcess(this.launchedObsPid);
			} catch (error) {
				console.warn('Failed to kill OBS process by PID:', error);
			}
		} else {
			console.log('Skipping OBS process kill (agent does not own current OBS process)');
		}
		this.launchedObsPid = null;
		this.ownsOBSProcess = false;
	}

	async startStreaming(
		streamConfig: StreamConfig,
		sceneName = 'SheetA',
		onFailure?: (reason: StreamFailureReason) => void
	): Promise<void> {
		this.onStreamFailure = onFailure;
		try {
			// Start OBS if not already running, with the correct scene
			if (!this.isConnected) {
				console.log('🎬 OBS not connected, starting OBS with scene:', sceneName);
				await this.startOBS(sceneName);
			} else {
				// If OBS is already running, just switch to the correct scene
				console.log('🔄 OBS already connected, switching to scene:', sceneName);
				await this.setCurrentScene(sceneName);
			}

			await this.startFFmpegStream(streamConfig);

			console.log('FFmpeg streaming from OBS virtual camera started successfully');
		} catch (error) {
			console.error('Failed to start FFmpeg streaming:', error);
			throw error;
		}
	}

	async stopVirtualCamera(): Promise<void> {
		if (!this.isConnected) {
			console.log('OBS not connected, virtual camera should already be stopped');
			return;
		}

		try {
			// Stop the virtual camera using OBS WebSocket
			await this.obs.call('StopVirtualCam');
			console.log('Virtual camera stopped successfully');
		} catch (error: any) {
			// Handle different types of errors gracefully
			if (error.code === 501) {
				console.log('StopVirtualCam not supported by this OBS version, virtual camera may stop automatically when OBS closes');
			} else {
				console.warn('Failed to stop virtual camera via WebSocket, it may already be stopped:', error.message || error);
			}
			// Don't throw error here as virtual camera might already be stopped or command not supported
		}
	}

	async stopStreaming(): Promise<void> {
		this.onStreamFailure = undefined; // Prevent failure callbacks during intentional stop
		try {
			// First stop FFmpeg streaming
			await this.stopFFmpegStream();

			// Stop the virtual camera
			try {
				await this.stopVirtualCamera();
			} catch (error) {
				console.warn('Failed to stop virtual camera, continuing with OBS shutdown:', error);
			}

			// Close OBS
			await this.stopOBS();

			console.log('Streaming stopped successfully (FFmpeg, Virtual Camera, OBS)');
		} catch (error) {
			console.error('Failed to stop streaming:', error);
			throw error;
		}
	}

	async setCurrentScene(sceneName: string): Promise<void> {
		if (!this.isConnected) {
			this.currentScene = sceneName;
			return;
		}

		try {
			await this.obs.call('SetCurrentProgramScene', {
				sceneName: sceneName
			});
			this.currentScene = sceneName;
			console.log(`Switched to OBS scene: ${sceneName}`);
		} catch (error) {
			console.error(`Failed to switch to scene ${sceneName}:`, error);
			throw error;
		}
	}

	async muteAudio(): Promise<void> {
		if (!this.isConnected) {
			return;
		}

		try {
			// Get all audio sources and mute them
			const { inputs } = await this.obs.call('GetInputList');
			console.log('Found audio inputs:', inputs.length);

			for (const input of inputs) {
				try {
					await this.obs.call('SetInputMute', {
						inputName: (input as any).inputName,
						inputMuted: true
					});
				} catch (error) {
					console.warn(`Failed to mute input:`, error);
				}
			}

			console.log('OBS audio muted');
		} catch (error) {
			console.error('Failed to mute OBS audio:', error);
			throw error;
		}
	}

	async unmuteAudio(): Promise<void> {
		if (!this.isConnected) {
			return;
		}

		try {
			// Get all audio sources and unmute them
			const { inputs } = await this.obs.call('GetInputList');
			console.log('Found audio inputs:', inputs.length);

			for (const input of inputs) {
				try {
					await this.obs.call('SetInputMute', {
						inputName: (input as any).inputName,
						inputMuted: false
					});
				} catch (error) {
					console.warn(`Failed to unmute input:`, error);
				}
			}

			console.log('OBS audio unmuted');
		} catch (error) {
			console.error('Failed to unmute OBS audio:', error);
			throw error;
		}
	}

	async startFFmpegStream(streamConfig: StreamConfig): Promise<void> {
		console.log('Starting FFmpeg stream from OBS Virtual Camera to YouTube...');

		// Build the FFmpeg command as individual arguments for proper parsing
		// Get the correct audio source for the current scene
		console.log(`🎵 About to get audio source. Current scene: "${this.currentScene}", isConnected: ${this.isConnected}`);
		const audioSource = this.getAudioSourceForScene();
		console.log(`🎵 Using audio source for scene ${this.currentScene}: ${audioSource}`);
		const profile = this.getStreamingProfile();
		console.log('🎛️ Streaming profile:', profile);

		const ffmpegArgs = [
			'-f', 'dshow',
			'-thread_queue_size', profile.videoThreadQueue,
			'-rtbufsize', profile.videoInputBuffer,
			'-pix_fmt', 'yuv420p',
			'-i', 'video=OBS Virtual Camera',
			'-itsoffset', '1.35',
			'-f', 'dshow',
			'-thread_queue_size', profile.audioThreadQueue,
			'-rtbufsize', profile.audioInputBuffer,
			'-i', `audio=${audioSource}`,
			'-map', '0:v',
			'-map', '1:a',
			'-af', 'volume=5dB',
			'-ac', '2',
			'-c:v', profile.videoCodec,
			'-rc', profile.videoRateControl,
			'-q', profile.videoQ,
			'-b:v', profile.videoBitrate,
			'-maxrate', profile.videoMaxrate,
			'-bufsize', profile.videoBufsize,
			'-vf', profile.videoFilter,
			'-c:a', 'aac',
			'-b:a', profile.audioBitrate,
			'-g', profile.gop,
			'-r', profile.fps,
			'-f', 'flv',
			`rtmp://a.rtmp.youtube.com/live2/${streamConfig.streamKey}`
		];

		console.log('FFmpeg command: ffmpeg', ffmpegArgs.join(' '));
		console.log('Current working directory:', process.cwd());

		// Spawn FFmpeg directly with arguments (not through cmd.exe)
		console.log('🎯 Spawning FFmpeg directly...');
		const { spawn } = require('child_process');

		this.ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: false,  // Don't detach so we can monitor it
			windowsHide: true  // Hide the console window
		});

		console.log('FFmpeg process spawned with PID:', this.ffmpegProcess?.pid);

		// Handle FFmpeg output
		if (this.ffmpegProcess?.stdout) {
			this.ffmpegProcess.stdout.on('data', (data: Buffer) => {
				console.log('FFmpeg stdout:', data.toString());
			});
		}

		if (this.ffmpegProcess?.stderr) {
			let droppedFrameWarnings = 0;
			let lastDroppedSummaryAt = 0;
			this.ffmpegProcess.stderr.on('data', (data: Buffer) => {
				const output = data.toString();
				const isDroppedFrameSpam =
					output.includes('real-time buffer [OBS Virtual Camera]') &&
					output.includes('frame dropped');
				if (isDroppedFrameSpam) {
					droppedFrameWarnings += 1;
					const now = Date.now();
					if (now - lastDroppedSummaryAt > 5000) {
						lastDroppedSummaryAt = now;
						console.warn(`FFmpeg input buffer pressure on OBS Virtual Camera (warnings=${droppedFrameWarnings}).`);
					}
					return;
				}
				if (output.includes('Last message repeated')) {
					return;
				}
				console.log('FFmpeg stderr:', output);

				// Check for specific error messages
				if (output.includes('Could not find video device')) {
					console.error('🚨 OBS Virtual Camera device not found!');
					console.error('This usually means:');
					console.error('1. OBS Virtual Camera is not started');
					console.error('2. OBS is not running');
					console.error('3. Device name is incorrect');
					console.error('4. Device is being used by another application');
				}
				if (output.includes('Could not find audio device')) {
					console.error('🚨 Dante Virtual Soundcard not found!');
				}
			});
		}

		this.ffmpegProcess?.on('close', (code: number | null) => {
			console.log(`FFmpeg process exited with code ${code}`);
			if (code !== 0 && code !== null) {
				console.warn(`⚠️  FFmpeg exited unexpectedly with code ${code}`);
				console.warn('This usually indicates a device access issue (e.g. OBS crashed)');
				// Trigger recovery when FFmpeg dies unexpectedly during stream
				if (this.onStreamFailure) {
					console.warn('🚨 FFmpeg crashed during stream - triggering recovery');
					this.onStreamFailure('ffmpeg');
				}
			}
			this.ffmpegProcess = null;
		});

		if (this.ffmpegProcess) {
			this.ffmpegProcess.on('error', (error: Error) => {
				console.error('Failed to spawn FFmpeg process:', error);
				throw error;
			});
		}

		console.log('FFmpeg streaming started');
	}

	async stopFFmpegStream(): Promise<void> {
		if (this.ffmpegProcess) {
			console.log('Stopping FFmpeg stream...');
			this.ffmpegProcess.kill('SIGTERM');

			// Wait for process to terminate
			await new Promise((resolve) => {
				const timeout = setTimeout(() => {
					if (this.ffmpegProcess) {
						this.ffmpegProcess.kill('SIGKILL');
					}
					resolve(void 0);
				}, 5000);

				if (this.ffmpegProcess) {
					this.ffmpegProcess.on('close', () => {
						clearTimeout(timeout);
						resolve(void 0);
					});
				} else {
					clearTimeout(timeout);
					resolve(void 0);
				}
			});

			this.ffmpegProcess = null;
			console.log('FFmpeg streaming stopped');
		}
	}

	private cleanup(): Promise<void> {
		// Cleanup is now handled directly in stopOBS to avoid circular calls
		return Promise.resolve();
	}

	isOBSConnected(): boolean {
		return this.isConnected;
	}

	getCurrentScene(): string {
		return this.currentScene;
	}
}