#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

console.log('🚀 Setting up Curling Team Microservice...\n');

// Create data directory
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
  console.log('✅ Created data directory');
} else {
  console.log('✅ Data directory already exists');
}

// Check for .env file
const envPath = path.join(__dirname, '.env');
if (!fs.existsSync(envPath)) {
  const envContent = `# Required: Path to SQLite database file
DB_PATH=./data/curling.db

# Optional: Server port (defaults to 3000)
PORT=3000
`;
  fs.writeFileSync(envPath, envContent);
  console.log('✅ Created .env file with default configuration');
} else {
  console.log('✅ .env file already exists');
}

console.log('\n📋 Setup complete!');
console.log('\nNext steps:');
console.log('1. Review and modify .env file if needed');
console.log('2. Run: npm run dev');
console.log('3. Test the API with: node tests/test-api.js');
console.log('\n📖 See readme.md for full documentation'); 