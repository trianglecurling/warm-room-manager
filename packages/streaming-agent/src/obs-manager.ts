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
			'--minimize-to-tray',
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

		// Wait a bit for OBS to start up
		await new Promise(resolve => setTimeout(resolve, 3000));

		// Try to connect to OBS WebSocket
		await this.connect();
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

	async startVirtualCamera(): Promise<void> {
		try {
			// Start the OBS Virtual Camera output
			await this.obs.call('StartVirtualCam');
			console.log('OBS Virtual Camera started');
		} catch (error) {
			console.error('Failed to start OBS Virtual Camera:', error);
			throw error;
		}
	}

	async stopVirtualCamera(): Promise<void> {
		try {
			// Stop the OBS Virtual Camera output
			await this.obs.call('StopVirtualCam');
			console.log('OBS Virtual Camera stopped');
		} catch (error) {
			console.error('Failed to stop OBS Virtual Camera:', error);
			// Don't throw here as this might fail if already stopped
		}
	}

	async startStreaming(streamConfig: StreamConfig, sceneName = 'Scene'): Promise<void> {
		if (!this.isConnected) {
			throw new Error('OBS not connected');
		}

		try {
			// Switch to the specified scene
			await this.setCurrentScene(sceneName);

			// Start the OBS virtual camera
			await this.startVirtualCamera();

			// Start FFmpeg streaming from OBS virtual camera to YouTube
			await this.startFFmpegStream(streamConfig);

			console.log('OBS virtual camera and FFmpeg streaming started successfully');
		} catch (error) {
			console.error('Failed to start OBS virtual camera streaming:', error);
			throw error;
		}
	}

	async stopStreaming(): Promise<void> {
		try {
			// Stop FFmpeg streaming first
			await this.stopFFmpegStream();

			// Stop OBS virtual camera
			if (this.isConnected) {
				await this.stopVirtualCamera();
			}

			console.log('OBS virtual camera and FFmpeg streaming stopped successfully');
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

		this.ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
			stdio: ['ignore', 'pipe', 'pipe']
		});

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
