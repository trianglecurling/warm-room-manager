import { OBSWebSocket } from 'obs-websocket-js';
import { ChildProcess } from 'child_process';

export interface OBSConfig {
	host: string;
	port: number;
	password?: string;
}

export interface StreamConfig {
	streamUrl: string;
	streamKey: string;
}

export class OBSManager {
	private obs: OBSWebSocket;
	private ffmpegProcess: ChildProcess | null = null;
	private isConnected = false;
	private currentScene = 'SheetA';

	constructor(config: OBSConfig = { host: 'localhost', port: 4455 }) {
		this.obs = new OBSWebSocket();

		this.obs.on('ConnectionOpened', () => {
			console.log('OBS WebSocket connected');
			this.isConnected = true;
		});

		this.obs.on('ConnectionClosed', () => {
			console.log('OBS WebSocket disconnected');
			this.isConnected = false;
		});

		this.obs.on('ConnectionError', (error) => {
			console.error('OBS WebSocket error:', error);
		});
	}

	async connect(): Promise<void> {
		try {
			await this.obs.connect(`ws://localhost:4455`, 'randompassword123');
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
				const errorMessage = error instanceof Error ? error.message : String(error);
				console.warn(`WebSocket connection attempt ${attempt}/${maxRetries} failed:`, errorMessage);

				if (attempt === maxRetries) {
					// This was the last attempt, throw the error
					throw new Error(`Failed to connect to OBS WebSocket after ${maxRetries} attempts: ${errorMessage}`);
				}

				// Wait before retrying
				console.log(`Waiting ${retryInterval}ms before retry...`);
				await new Promise(resolve => setTimeout(resolve, retryInterval));
			}
		}
	}

	async disconnect(): Promise<void> {
		if (this.isConnected) {
			await this.obs.disconnect();
		}
		this.cleanup();
	}

	async startOBS(sceneName: string = 'SheetA'): Promise<void> {
		const obsPath = process.env.OBS_PATH || 'obs64.exe';

		console.log('Starting OBS with path:', obsPath, 'and scene:', sceneName);
		const { spawn } = require('child_process');

		const obsDir = obsPath.includes('\\') ? obsPath.substring(0, obsPath.lastIndexOf('\\')) : process.cwd();
		console.log('OBS working directory:', obsDir);

		const obsProcess = spawn(obsPath, [
			'--websocket_port=4455',
			'--websocket_password=randompassword123',
			'--collection', 'auto4k',
			'--scene', sceneName,
			'--multi',
			'--disable-shutdown-check',
			'--disable-updater',
			'--startvirtualcam'
		], {
			cwd: obsDir, // Set working directory to OBS installation directory
			detached: true,
			stdio: 'ignore'
		});

		obsProcess.unref();

		obsProcess.on('error', (error: Error) => {
			console.error('Failed to start OBS process:', error);
			throw new Error(`OBS startup failed: ${error.message}`);
		});

		obsProcess.on('exit', (code: number | null, signal: string | null) => {
			console.log(`OBS process exited with code: ${code}, signal: ${signal}`);
			if (code !== 0 && code !== null) {
				console.warn(`OBS exited unexpectedly with code ${code}`);
			}
		});

		// Wait longer for OBS to fully initialize (15 seconds)
		console.log('Waiting 15 seconds for OBS to fully initialize...');
		await new Promise(resolve => setTimeout(resolve, 15000));

		// Try to connect to OBS WebSocket with retry logic (up to ~15 seconds total)
		console.log('OBS should now be ready for WebSocket connection');
		await this.connectWithRetry(15, 1000); // 15 attempts, 1 second apart (~15 seconds total)
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

		// Force close OBS process if needed
		try {
			const { spawn } = require('child_process');
			const obsExeName = 'obs64.exe';
			console.log(`Stopping OBS process: ${obsExeName}`);
			spawn('taskkill', ['/f', '/im', obsExeName], {
				stdio: 'ignore'
			});
		} catch (error) {
			console.warn('Failed to kill OBS process:', error);
		}
	}

	async startStreaming(streamConfig: StreamConfig, sceneName = 'SheetA'): Promise<void> {
		try {
			// Start OBS if not already running, with the correct scene
			if (!this.isConnected) {
				await this.startOBS(sceneName);
			} else {
				// If OBS is already running, just switch to the correct scene
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
		const ffmpegArgs = [
			'-f', 'dshow',
			'-rtbufsize', '1000M',
			'-pix_fmt', 'yuv420p',
			'-i', 'video=OBS Virtual Camera',
			'-itsoffset', '1.35',
			'-f', 'dshow',
			'-rtbufsize', '100M',
			'-i', 'audio=DVS Receive  1-2 (Dante Virtual Soundcard)',
			'-map', '0:v',
			'-map', '1:a',
			'-af', 'volume=5dB',
			'-ac', '2',
			'-c:v', 'hevc_amf',
			'-rc', 'cqp',
			'-q', '20',
			'-b:v', '15000k',
			'-maxrate', '20000k',
			'-bufsize', '45000k',
			'-vf', 'scale=1920:1080,format=yuv420p',
			'-c:a', 'aac',
			'-b:a', '128k',
			'-g', '120',
			'-r', '60',
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
			this.ffmpegProcess.stderr.on('data', (data: Buffer) => {
				const output = data.toString();
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
				console.warn('This usually indicates a device access issue');
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