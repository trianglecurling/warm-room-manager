import { google } from 'googleapis';
import { YouTubeMetadata } from '@warm-room-manager/shared';

const YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const YOUTUBE_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const YOUTUBE_REFRESH_TOKEN = process.env.YOUTUBE_REFRESH_TOKEN;

if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET || !YOUTUBE_REFRESH_TOKEN) {
	console.warn('YouTube OAuth2 credentials not set - YouTube integration will be disabled');
	console.warn('Required: YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN');
	console.warn('Run: node setup-youtube-oauth.js');
}

export class YouTubeService {
	private youtube;
	private oauth2Client;

	constructor() {
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
	 * Create a new YouTube live broadcast
	 */
	async createLiveBroadcast(title: string, description: string): Promise<YouTubeMetadata> {
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
						privacyStatus: 'unlisted', // As requested for testing
						selfDeclaredMadeForKids: false, // Explicitly set as not made for kids
					},
					contentDetails: {
						enableAutoStart: false,
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
			const metadata: YouTubeMetadata = {
				broadcastId: broadcast.id || undefined,
				streamId: stream.id || undefined,
				streamKey: stream.cdn?.ingestionInfo?.streamName || undefined,
				streamUrl: stream.cdn?.ingestionInfo?.ingestionAddress || undefined,
				privacyStatus: 'unlisted',
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
		if (!this.youtube) {
			throw new Error('YouTube OAuth2 credentials not configured');
		}

		try {
			await this.youtube.liveBroadcasts.update({
				part: ['snippet'],
				requestBody: {
					id: broadcastId,
					snippet: {
						...updates,
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
	 * Generate a stream title and description
	 */
	static generateStreamTitle(): string {
		const now = new Date();
		const timestamp = now.toLocaleString('en-US', {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
		});
		return `Live Sports Stream - ${timestamp}`;
	}

	static generateStreamDescription(): string {
		return 'This is an automated sports live stream created by the Stream Control system. Join us for an exciting sports broadcast!';
	}
}

// Export singleton instance
export const youtubeService = new YouTubeService();
