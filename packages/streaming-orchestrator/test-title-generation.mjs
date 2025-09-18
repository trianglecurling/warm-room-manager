#!/usr/bin/env node

/**
 * Test Stream Title Generation
 * Run with: node test-title-generation.mjs
 */

// Test title generation function (standalone - no imports needed)
function generateStreamTitle(context) {
	const parts = [];

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

	// Add today's date (always use current date)
	const today = new Date();
	const formattedDate = `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`;
	parts.push(formattedDate);

	return parts.join(' - ');
}

function generateStreamDescription(context) {
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

// Test cases
const testCases = [
	{
		name: "Full tournament match",
		context: {
			context: "Tournament",
			drawNumber: 3,
			sheet: "A",
			team1: "Team Alpha",
			team2: "Team Beta"
		}
	},
	{
		name: "Vibe stream (no draw number)",
		context: {
			context: "League",
			sheet: "vibe",
			team1: "Team Red",
			team2: "Team Blue"
		}
	},
	{
		name: "Sheet B match",
		context: {
			context: "Championship",
			drawNumber: 1,
			sheet: "B",
			team1: "Champions FC",
			team2: "Underdogs United"
		}
	},
	{
		name: "Minimal context",
		context: {
			context: "Practice",
			sheet: "C"
		}
	}
];

console.log('🧪 Testing Stream Title Generation\n');
console.log('=' .repeat(50));

testCases.forEach((testCase, index) => {
	console.log(`\n📋 Test ${index + 1}: ${testCase.name}`);
	console.log('-'.repeat(40));

	const title = generateStreamTitle(testCase.context);
	const description = generateStreamDescription(testCase.context);

	console.log(`📺 Title: ${title}`);
	console.log(`📝 Description: ${description}`);
	console.log(`📊 Context: ${JSON.stringify(testCase.context, null, 2)}`);
});

console.log('\n' + '='.repeat(50));
console.log('✅ Title generation test completed!');

// Example API call
console.log('\n🚀 Example API Request:');
console.log(JSON.stringify({
	templateId: null,
	inlineConfig: { streamUrl: "rtmp://example.com/live" },
	streamContext: {
		context: "Tournament",
		drawNumber: 3,
		sheet: "A",
		team1: "Team Alpha",
		team2: "Team Beta"
	},
	idempotencyKey: "tournament-stream-001"
}, null, 2));
