#!/usr/bin/env node

/**
 * YouTube OAuth2 Setup Script
 * This script helps you obtain OAuth2 credentials for YouTube API access
 *
 * Run with: node setup-youtube-oauth.js
 */

import "dotenv/config";
import { google } from 'googleapis';
import { createServer } from 'http';
import { parse } from 'url';
import { writeFileSync, readFileSync } from 'fs';

const CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
	console.log('❌ Missing OAuth2 credentials');
	console.log('');
	console.log('Please set these environment variables first:');
	console.log('YOUTUBE_CLIENT_ID=your-client-id');
	console.log('YOUTUBE_CLIENT_SECRET=your-client-secret');
	console.log('');
	console.log('To get these values:');
	console.log('1. Go to https://console.cloud.google.com/');
	console.log('2. Create/select a project');
	console.log('3. Enable YouTube Data API v3');
	console.log('4. Go to "Credentials" → "Create Credentials" → "OAuth 2.0 Client IDs"');
	console.log('5. Set application type to "Web application"');
	console.log('6. Add authorized redirect URIs: http://localhost:3014/oauth2callback');
	console.log('7. Copy the Client ID and Client Secret');
	process.exit(1);
}

async function setupOAuth2() {
	console.log('🚀 Setting up YouTube OAuth2...');
	console.log('');

	const oauth2Client = new google.auth.OAuth2(
		CLIENT_ID,
		CLIENT_SECRET,
		'http://localhost:3014/oauth2callback'
	);

	// Generate the authorization URL
	const authUrl = oauth2Client.generateAuthUrl({
		access_type: 'offline',
		scope: [
			'https://www.googleapis.com/auth/youtube',
			'https://www.googleapis.com/auth/youtube.force-ssl',
			'https://www.googleapis.com/auth/youtube.upload'
		],
		prompt: 'consent' // Force refresh token
	});

	console.log('📋 Please visit this URL to authorize the application:');
	console.log('');
	console.log(authUrl);
	console.log('');
	console.log('⚠️  IMPORTANT: Make sure to grant ALL requested permissions');
	console.log('');

	// Create a temporary server to handle the callback
	const server = createServer(async (req, res) => {
		try {
			const host = req.headers.host || 'localhost:3014';
			const url = new URL(req.url, `http://${host}`);
			const code = url.searchParams.get('code');

			if (code) {
				console.log('🔄 Exchanging authorization code for tokens...');

				const { tokens } = await oauth2Client.getToken(code);
				oauth2Client.setCredentials(tokens);

				console.log('✅ OAuth2 setup complete!');
				console.log('');
				console.log('📝 Add this to your .env file:');
				console.log('');
				console.log(`YOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}`);
				console.log('');
				console.log('💡 Keep the refresh token secure - it never expires!');
				console.log('');

				// Save to .env file
				try {
					let envContent = '';
					try {
						envContent = readFileSync('.env', 'utf8');
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
						writeFileSync('.env', updatedLines.join('\n'));
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

						writeFileSync('.env', updatedEnv);
						console.log('✅ Added YOUTUBE_REFRESH_TOKEN to .env file');
					}
				} catch (error) {
					console.log('⚠️  Could not save to .env file automatically');
					console.log('Please add the credentials manually');
				}

				res.writeHead(200, { 'Content-Type': 'text/html' });
				res.end(`
					<html>
						<body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
							<h1 style="color: #28a745;">✅ Success!</h1>
							<p>YouTube OAuth2 has been configured successfully.</p>
							<p>You can close this window and return to the terminal.</p>
						</body>
					</html>
				`);

				server.close();
				process.exit(0);
			} else {
				res.writeHead(400, { 'Content-Type': 'text/html' });
				res.end(`
					<html>
						<body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
							<h1 style="color: #dc3545;">❌ Error</h1>
							<p>No authorization code received.</p>
						</body>
					</html>
				`);
			}
		} catch (error) {
			console.error('❌ OAuth2 setup failed:', error);
			res.writeHead(500, { 'Content-Type': 'text/html' });
			res.end(`
				<html>
					<body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
						<h1 style="color: #dc3545;">❌ Setup Failed</h1>
						<p>${error.message}</p>
					</body>
				</html>
			`);
			server.close();
			process.exit(1);
		}
	});

	server.listen(3014, () => {
		console.log('🌐 Local server started at http://localhost:3014');
		console.log('⏳ Waiting for authorization...');
		console.log('');
		console.log('💡 Tip: The authorization page should open automatically in your browser');
		console.log('   If not, copy and paste the URL above into your browser');
	});
}

// Handle graceful shutdown
process.on('SIGINT', () => {
	console.log('\n👋 OAuth2 setup cancelled');
	process.exit(0);
});

setupOAuth2().catch(console.error);
