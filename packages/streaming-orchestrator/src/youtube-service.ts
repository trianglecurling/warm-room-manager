import { google } from 'googleapis';
import { YouTubeMetadata } from '@warm-room-manager/shared';

const YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const YOUTUBE_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const YOUTUBE_REFRESH_TOKEN = process.env.YOUTUBE_REFRESH_TOKEN;
const YOUTUBE_STREAM_PRIVACY = process.env.YOUTUBE_STREAM_PRIVACY || 'unlisted';
const DISABLE_YOUTUBE_API = process.env.DISABLE_YOUTUBE_API === 'true';

if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET || !YOUTUBE_REFRESH_TOKEN) {
	console.warn('YouTube OAuth2 credentials not set - YouTube integration will be disabled');
	console.warn('Required: YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN');
	console.warn('Run: node setup-youtube-oauth.js');
}

export class YouTubeService {
	private youtube;
	private oauth2Client;

	constructor() {
		if (DISABLE_YOUTUBE_API) {
			console.warn('⚠️  YouTube API calls are DISABLED for testing (DISABLE_YOUTUBE_API=true)');
			this.youtube = null as any;
			this.oauth2Client = null as any;
			return;
		}

		if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET || !YOUTUBE_REFRESH_TOKEN) {
			this.youtube = null as any;
			this.oauth2Client = null as any;
			return;
		}

		this.oauth2Client = new google.auth.OAuth2(
			YOUTUBE_CLIENT_ID,
			YOUTUBE_CLIENT_SECRET
		);

		this.oauth2Client.setCredentials({
			refresh_token: YOUTUBE_REFRESH_TOKEN
		});

		this.youtube = google.youtube({
			version: 'v3',
			auth: this.oauth2Client,
		});

		console.log('✅ YouTube OAuth2 authentication configured');
	}

	/**
	 * Update the OAuth2 refresh token
	 * This allows updating credentials without restarting the service
	 */
	updateRefreshToken(refreshToken: string): void {
		if (DISABLE_YOUTUBE_API) {
			return;
		}

		if (!this.oauth2Client) {
			console.warn('⚠️  Cannot update refresh token: OAuth2 client not initialized');
			return;
		}

		this.oauth2Client.setCredentials({
			refresh_token: refreshToken
		});

		console.log('✅ YouTube OAuth2 refresh token updated');
	}

	/**
	 * Create a new YouTube live broadcast
	 */
	async createLiveBroadcast(title: string, description: string, privacy?: 'public' | 'unlisted'): Promise<YouTubeMetadata> {
		if (DISABLE_YOUTUBE_API) {
			console.log(`🎭 YouTube API DISABLED - Returning mock broadcast data for: "${title}"`);

			// Return mock data for testing
			const mockBroadcastId = `mock-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
			return {
				broadcastId: mockBroadcastId,
				streamId: `mock-stream-${mockBroadcastId}`,
				streamKey: `mock-stream-key-${mockBroadcastId}`,
				streamUrl: 'rtmp://mock.youtube.com/live2',
				privacyStatus: privacy || 'unlisted',
				scheduledStartTime: new Date(Date.now() + 60000).toISOString(),
				channelId: 'mock-channel-id',
				videoId: mockBroadcastId
			};
		}

		if (!this.youtube) {
			throw new Error('YouTube OAuth2 credentials not configured');
		}

		try {
			// Create the broadcast
			const broadcastResponse = await this.youtube.liveBroadcasts.insert({
				part: ['snippet', 'status', 'contentDetails'],
				requestBody: {
					snippet: {
						title,
						description,
						scheduledStartTime: new Date(Date.now() + 60000).toISOString(), // Start in 1 minute
					},
					status: {
						privacyStatus: (privacy || 'unlisted') as 'public' | 'unlisted',
						selfDeclaredMadeForKids: false, // Explicitly set as not made for kids
					},
					contentDetails: {
						enableAutoStart: true,
						enableAutoStop: false,
						enableContentEncryption: false,
						enableDvr: true,
						enableEmbed: true,
						recordFromStart: true,
						startWithSlate: false,
					},
				},
			});

			const broadcast = broadcastResponse.data;

			console.log("Updating broadcast with Sports category");

			// Update the broadcast with the Sports category (must be done after creation)
			if (broadcast.id) {
				await this.youtube.liveBroadcasts.update({
					part: ['snippet'],
					requestBody: {
						id: broadcast.id,
						snippet: {
							title: broadcast.snippet?.title,
							description: broadcast.snippet?.description,
							scheduledStartTime: broadcast.snippet?.scheduledStartTime,
							categoryId: '17', // Sports category
						},
					},
				});
			}

			// Create the stream
			const streamResponse = await this.youtube.liveStreams.insert({
				part: ['snippet', 'cdn', 'status'],
				requestBody: {
					snippet: {
						title: `${title} - Stream`,
						description: `Live stream for ${title}`,
					},
					cdn: {
						format: '1080p',
						ingestionType: 'rtmp',
						resolution: '1080p',
						frameRate: '60fps',
					},
				},
			});

			const stream = streamResponse.data;

			// Bind the stream to the broadcast
			await this.youtube.liveBroadcasts.bind({
				id: broadcast.id!,
				part: ['id'],
				streamId: stream.id!,
			});

			// Generate YouTube metadata
			const actualPrivacy = (privacy || 'unlisted') as 'public' | 'unlisted';
			const metadata: YouTubeMetadata = {
				broadcastId: broadcast.id || undefined,
				streamId: stream.id || undefined,
				streamKey: stream.cdn?.ingestionInfo?.streamName || undefined,
				streamUrl: stream.cdn?.ingestionInfo?.ingestionAddress || undefined,
				privacyStatus: actualPrivacy,
				scheduledStartTime: broadcast.snippet?.scheduledStartTime || undefined,
				channelId: broadcast.snippet?.channelId || undefined,
				videoId: broadcast.id || undefined, // Broadcast ID is also the video ID
			};

			console.log(`Created YouTube live broadcast: ${broadcast.id}`);
			console.log(`Stream URL: ${metadata.streamUrl}`);
			console.log(`Stream Key: ${metadata.streamKey}`);

			return metadata;
		} catch (error) {
			console.error('Failed to create YouTube live broadcast:', error);
			throw new Error(`YouTube API error: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	}

	/**
	 * Get broadcast status and statistics
	 */
	async getBroadcastStatus(broadcastId: string): Promise<Partial<YouTubeMetadata>> {
		if (DISABLE_YOUTUBE_API) {
			console.log(`🎭 YouTube API DISABLED - Returning mock status for broadcast: ${broadcastId}`);
			return {
				actualStartTime: new Date().toISOString(),
				concurrentViewers: Math.floor(Math.random() * 100),
				totalViewers: Math.floor(Math.random() * 1000)
			};
		}

		if (!this.youtube) {
			throw new Error('YouTube OAuth2 credentials not configured');
		}

		try {
			const response = await this.youtube.liveBroadcasts.list({
				part: ['status', 'statistics'],
				id: [broadcastId],
			});

			const broadcast = response.data.items?.[0];
			if (!broadcast) {
				throw new Error(`Broadcast ${broadcastId} not found`);
			}

			return {
				actualStartTime: (broadcast.status as any)?.actualStartTime || undefined,
				actualEndTime: (broadcast.status as any)?.actualEndTime || undefined,
				concurrentViewers: broadcast.statistics?.concurrentViewers ? Number(broadcast.statistics.concurrentViewers) : undefined,
				totalViewers: (broadcast.statistics as any)?.totalViewers ? Number((broadcast.statistics as any).totalViewers) : undefined,
				likeCount: (broadcast.statistics as any)?.likeCount ? Number((broadcast.statistics as any).likeCount) : undefined,
				dislikeCount: (broadcast.statistics as any)?.dislikeCount ? Number((broadcast.statistics as any).dislikeCount) : undefined,
				commentCount: (broadcast.statistics as any)?.commentCount ? Number((broadcast.statistics as any).commentCount) : undefined,
			};
		} catch (error) {
			console.error(`Failed to get broadcast status for ${broadcastId}:`, error);
			throw new Error(`YouTube API error: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	}

	/**
	 * Update broadcast metadata
	 */
	async updateBroadcast(broadcastId: string, updates: { title?: string; description?: string }): Promise<void> {
		if (DISABLE_YOUTUBE_API) {
			console.log(`🎭 YouTube API DISABLED - Mock update for broadcast: ${broadcastId}`, updates);
			return;
		}

		if (!this.youtube) {
			throw new Error('YouTube OAuth2 credentials not configured');
		}

		try {
			// First, get the current broadcast data to preserve required fields
			const currentBroadcast = await this.youtube.liveBroadcasts.list({
				part: ['snippet'],
				id: [broadcastId],
			});

			const broadcast = currentBroadcast.data.items?.[0];
			if (!broadcast || !broadcast.snippet) {
				throw new Error(`Broadcast ${broadcastId} not found`);
			}

			// Update the broadcast with merged snippet data
			await this.youtube.liveBroadcasts.update({
				part: ['snippet'],
				requestBody: {
					id: broadcastId,
					snippet: {
						...broadcast.snippet,
						title: updates.title ?? broadcast.snippet.title,
						description: updates.description ?? broadcast.snippet.description,
					},
				},
			});

			console.log(`Updated YouTube broadcast ${broadcastId}`);
		} catch (error) {
			console.error(`Failed to update broadcast ${broadcastId}:`, error);
			throw new Error(`YouTube API error: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	}

	/**
	 * End a broadcast explicitly (required when auto-stop is disabled)
	 */
	async endBroadcast(broadcastId: string): Promise<void> {
		if (DISABLE_YOUTUBE_API) {
			console.log(`🎭 YouTube API DISABLED - Mock end broadcast: ${broadcastId}`);
			return;
		}

		if (!this.youtube) {
			throw new Error('YouTube OAuth2 credentials not configured');
		}

		try {
			await this.youtube.liveBroadcasts.transition({
				part: ['status'],
				broadcastStatus: 'complete',
				id: broadcastId,
			});
			console.log(`Completed YouTube broadcast ${broadcastId}`);
		} catch (error) {
			console.error(`Failed to end broadcast ${broadcastId}:`, error);
			throw new Error(`YouTube API error: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	}

	/**
	 * Get broadcast + stream status for health monitoring
	 */
	async getBroadcastAndStreamStatus(broadcastId: string, streamId: string): Promise<{
		lifeCycleStatus?: string;
		actualEndTime?: string;
		streamStatus?: string;
	}> {
		if (DISABLE_YOUTUBE_API) {
			console.log(`🎭 YouTube API DISABLED - Returning mock health status for broadcast: ${broadcastId}`);
			return {
				lifeCycleStatus: 'live',
				actualEndTime: undefined,
				streamStatus: 'active',
			};
		}

		if (!this.youtube) {
			throw new Error('YouTube OAuth2 credentials not configured');
		}

		try {
			const [broadcastResponse, streamResponse] = await Promise.all([
				this.youtube.liveBroadcasts.list({
					part: ['status'],
					id: [broadcastId],
				}),
				this.youtube.liveStreams.list({
					part: ['status'],
					id: [streamId],
				}),
			]);

			const broadcast = broadcastResponse.data.items?.[0];
			const stream = streamResponse.data.items?.[0];

			return {
				lifeCycleStatus: (broadcast?.status as any)?.lifeCycleStatus,
				actualEndTime: (broadcast?.status as any)?.actualEndTime,
				streamStatus: (stream?.status as any)?.streamStatus,
			};
		} catch (error) {
			console.error(`Failed to get broadcast/stream status for ${broadcastId}:`, error);
			throw new Error(`YouTube API error: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	}

	/**
	 * Generate a stream title and description
	 */
	static generateStreamTitle(): string {
		const now = new Date();
		const month = now.getMonth() + 1;
		const day = now.getDate();
		const year = now.getFullYear();
		const timeString = now.toLocaleString('en-US', {
			hour: 'numeric',
			minute: '2-digit',
			hour12: true
		});

		return `Triangle Curling - Live Stream - ${month}/${day}/${year} ${timeString}`;
	}

	static generateStreamDescription(): string {
		return 'To watch other sheets, visit https://www.youtube.com/@TriangleCurling/streams';
	}
}

// Export singleton instance
export const youtubeService = new YouTubeService();
