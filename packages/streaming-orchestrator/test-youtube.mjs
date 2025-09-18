#!/usr/bin/env node

/**
 * Test script for YouTube API integration
 * Run with: node test-youtube.js
 */

import 'dotenv/config';
import { YouTubeService } from './dist/youtube-service.js';

async function testYouTubeIntegration() {
    console.log('🧪 Testing YouTube API Integration...\n');

    const YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
    const YOUTUBE_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
    const YOUTUBE_REFRESH_TOKEN = process.env.YOUTUBE_REFRESH_TOKEN;

    if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET || !YOUTUBE_REFRESH_TOKEN) {
        console.error('❌ YouTube OAuth2 credentials not found in environment variables');
        console.log('');
        console.log('Please set the following environment variables in your .env file:');
        console.log('YOUTUBE_CLIENT_ID=your-client-id');
        console.log('YOUTUBE_CLIENT_SECRET=your-client-secret');
        console.log('YOUTUBE_REFRESH_TOKEN=your-refresh-token');
        console.log('');
        console.log('To get these credentials, run:');
        console.log('node setup-youtube-oauth.js');
        process.exit(1);
    }

    console.log('✅ YouTube OAuth2 credentials found');

    try {
        // Test creating a live broadcast
        console.log('\n📺 Creating YouTube live broadcast...');

        const title = YouTubeService.generateStreamTitle();
        const description = YouTubeService.generateStreamDescription();

        console.log(`Title: ${title}`);
        console.log(`Description: ${description}`);

        const youtubeService = new YouTubeService();
        const metadata = await youtubeService.createLiveBroadcast(title, description);

        console.log('\n✅ Live broadcast created successfully!');
        console.log(`📹 Broadcast ID: ${metadata.broadcastId}`);
        console.log(`🔗 Public URL: https://youtube.com/watch?v=${metadata.videoId}`);
        console.log(`🎛️  Admin URL: https://studio.youtube.com/video/${metadata.videoId}/livestreaming`);
        console.log(`🔑 Stream Key: ${metadata.streamKey}`);
        console.log(`🌐 RTMP URL: ${metadata.streamUrl}`);

        // Test getting broadcast status
        console.log('\n📊 Testing broadcast status retrieval...');

        if (metadata.broadcastId) {
            const status = await youtubeService.getBroadcastStatus(metadata.broadcastId);
            console.log('✅ Broadcast status retrieved:', status);
        }

        console.log('\n🎉 YouTube API integration test completed successfully!');
        console.log('\n💡 Next steps:');
        console.log('1. Use the RTMP URL and Stream Key in your streaming software');
        console.log('2. Visit the Admin URL to manage your live stream');
        console.log('3. The Public URL is where viewers can watch');

    } catch (error) {
        console.error('\n❌ YouTube API test failed:', error.message);

        if (error.message.includes('API has not been used')) {
            console.log('\n💡 Troubleshooting:');
            console.log('1. Make sure YouTube Data API v3 is enabled in Google Cloud Console');
            console.log('2. Verify your API key has the correct permissions');
            console.log('3. Check that your YouTube channel is verified for live streaming');
        }

        process.exit(1);
    }
}

// Run the test
testYouTubeIntegration().catch(console.error);
