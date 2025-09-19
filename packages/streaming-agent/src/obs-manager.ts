import OBSWebSocket from 'obs-websocket-js';
import { spawn, ChildProcess } from 'child_process';
import { StreamMetadata } from '@warm-room-manager/shared';

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
	private config: OBSConfig;
	private websocketPassword: string;

	constructor(config: OBSConfig = { host: 'localhost', port: 4455 }) {
		this.config = config;
		// Generate a random password for WebSocket authentication
		this.websocketPassword = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
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
			const { obsWebSocketVersion } = await this.obs.connect(
				`ws://${this.config.host}:${this.config.port}`,
				this.websocketPassword
			);
			console.log(`OBS WebSocket connected (version: ${obsWebSocketVersion})`);
		} catch (error) {
			console.error('Failed to connect to OBS:', error);
			throw error;
		}
	}

	async connectWithRetry(maxRetries = 10, retryInterval = 1000): Promise<void> {
		console.log(`Attempting to connect to OBS WebSocket (will retry up to ${maxRetries} times)...`);

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				console.log(`WebSocket connection attempt ${attempt}/${maxRetries}...`);
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

	async startOBS(): Promise<void> {
		const obsPath = process.env.OBS_PATH || 'obs64.exe';
		console.log(`Starting OBS using path: ${obsPath}`);

		// Extract OBS directory from the executable path
		const obsDir = obsPath.includes('\\') ? obsPath.substring(0, obsPath.lastIndexOf('\\')) : process.cwd();
		console.log(`OBS working directory: ${obsDir}`);

		// Launch OBS with comprehensive launch parameters
		console.log(`OBS WebSocket port: ${this.config.port}, password: ${this.websocketPassword}`);
		console.log(`OBS starting scene: ${this.currentScene}`);
		console.log(`OBS virtual camera will start automatically via --startvirtualcam`);

		const obsProcess = spawn(obsPath, [
			`--websocket_port=${this.config.port}`,
			`--websocket_password=${this.websocketPassword}`,
			'--collection',
			'auto4k',
			'--scene',
			this.currentScene,
			'--multi', // don't warn when launching multiple instances
			'--disable-shutdown-check',
			'--disable-updater',
			'--startvirtualcam'
		], {
			cwd: obsDir, // Set working directory to OBS installation directory
			detached: true,
			stdio: 'ignore'
		});

		obsProcess.unref();

		// Handle OBS process errors
		obsProcess.on('error', (error) => {
			console.error('Failed to start OBS process:', error);
			throw new Error(`OBS startup failed: ${error.message}`);
		});

		obsProcess.on('exit', (code, signal) => {
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

		// Stop virtual camera and FFmpeg first
		try {
			await this.stopStreaming();
		} catch (error) {
			console.warn('Failed to stop streaming gracefully:', error);
		}

		this.cleanup();

		// Try to close OBS gracefully (no streaming to stop since we use FFmpeg)
		try {
			if (this.isConnected) {
				// OBS might still be running, just disconnect WebSocket
				await this.obs.disconnect();
			}
		} catch (error) {
			console.warn('Failed to disconnect OBS gracefully:', error);
		}

		// Force close OBS process if needed
		try {
			const obsPath = process.env.OBS_PATH || 'obs64.exe';
			// Extract just the executable name for taskkill (e.g., "obs64.exe" from full path)
			const obsExeName = obsPath.split('\\').pop() || 'obs64.exe';
			console.log(`Stopping OBS process: ${obsExeName}`);
			spawn('taskkill', ['/f', '/im', obsExeName], {
				stdio: 'ignore'
			});
		} catch (error) {
			console.warn('Failed to kill OBS process:', error);
		}
	}


	async startStreaming(streamConfig: StreamConfig, sceneName = 'Scene'): Promise<void> {
		if (!this.isConnected) {
			throw new Error('OBS not connected');
		}

		try {
			// Switch to the specified scene
			await this.setCurrentScene(sceneName);

			// Virtual camera is already started via --startvirtualcam launch parameter
			// Just start FFmpeg streaming from OBS virtual camera to YouTube
			await this.startFFmpegStream(streamConfig);

			console.log('FFmpeg streaming from OBS virtual camera started successfully');
		} catch (error) {
			console.error('Failed to start FFmpeg streaming:', error);
			throw error;
		}
	}

	async stopStreaming(): Promise<void> {
		try {
			// Stop FFmpeg streaming first
			await this.stopFFmpegStream();

			// Virtual camera will stop automatically when OBS shuts down
			console.log('FFmpeg streaming stopped successfully');
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

			for (const input of inputs) {
				try {
					const inputName = input.inputName as string;
					if (inputName) {
						await this.obs.call('SetInputMute', {
							inputName,
							inputMuted: true
						});
					}
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

			for (const input of inputs) {
				try {
					const inputName = input.inputName as string;
					if (inputName) {
						await this.obs.call('SetInputMute', {
							inputName,
							inputMuted: false
						});
					}
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

		// Exact FFmpeg command as specified in requirements
		const ffmpegArgs = [
			'-f', 'dshow',
			'-rtbufsize', '1000M',
			'-pix_fmt', 'yuv420p',
			'-i', 'video="OBS Virtual Camera"',
			'-itsoffset', '1.35',
			'-f', 'dshow',
			'-rtbufsize', '100M',
			'-i', 'audio="DVS Receive  1-2 (Dante Virtual Soundcard)"',
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
			`rtmp://${streamConfig.streamUrl.replace('rtmp://', '')}/${streamConfig.streamKey}`
		];

		console.log('FFmpeg command:', 'ffmpeg', ffmpegArgs.join(' '));
		console.log('Current working directory:', process.cwd());
		console.log('PATH environment sample:', process.env.PATH?.split(';').slice(0, 3).join(';') + '...');

		// Use the same working directory as OBS for consistency
		const obsPath = process.env.OBS_PATH || 'obs64.exe';
		const ffmpegCwd = obsPath.includes('\\') ? obsPath.substring(0, obsPath.lastIndexOf('\\')) : process.cwd();

		console.log('FFmpeg working directory will be:', ffmpegCwd);

		// Quick check if FFmpeg is available
		try {
			const { spawn } = require('child_process');
			const testProcess = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
			await new Promise((resolve, reject) => {
				testProcess.on('close', (code: number | null) => {
					if (code === 0) {
						console.log('✅ FFmpeg is available and working');
						resolve(void 0);
					} else {
						reject(new Error(`FFmpeg exited with code ${code}`));
					}
				});
				testProcess.on('error', reject);
				// Timeout after 5 seconds
				setTimeout(() => reject(new Error('FFmpeg test timeout')), 5000);
			});
		} catch (ffmpegTestError) {
			const errorMessage = ffmpegTestError instanceof Error ? ffmpegTestError.message : String(ffmpegTestError);
			console.warn('⚠️  FFmpeg availability test failed:', errorMessage);
			console.warn('This might cause the streaming to fail');
		}

		// Try to spawn FFmpeg with better error handling
		try {
			this.ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
				cwd: ffmpegCwd,  // Use same working directory as OBS
				stdio: ['ignore', 'pipe', 'pipe'],
				env: { ...process.env }  // Pass through all environment variables
			});

			console.log('FFmpeg process spawned with PID:', this.ffmpegProcess.pid);

		} catch (spawnError) {
			console.error('Failed to spawn FFmpeg process:', spawnError);
			console.error('Possible causes:');
			console.error('1. FFmpeg is not installed');
			console.error('2. FFmpeg is not in system PATH');
			console.error('3. Working directory issue:', ffmpegCwd);
			throw spawnError;
		}

		// Handle FFmpeg output
		if (this.ffmpegProcess.stdout) {
			this.ffmpegProcess.stdout.on('data', (data) => {
				console.log('FFmpeg stdout:', data.toString());
			});
		}

		if (this.ffmpegProcess.stderr) {
			this.ffmpegProcess.stderr.on('data', (data) => {
				console.log('FFmpeg stderr:', data.toString());
			});
		}

		if (this.ffmpegProcess) {
			this.ffmpegProcess.on('close', (code) => {
				console.log(`FFmpeg process exited with code ${code}`);
				this.ffmpegProcess = null;
			});
		}

		if (this.ffmpegProcess) {
			this.ffmpegProcess.on('error', (error) => {
				console.error('FFmpeg process error:', error);
				this.ffmpegProcess = null;
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
		return this.stopFFmpegStream();
	}

	isOBSConnected(): boolean {
		return this.isConnected;
	}

	getCurrentScene(): string {
		return this.currentScene;
	}
}
