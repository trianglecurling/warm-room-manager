#!/usr/bin/env node

import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config();

console.log('🗑️  Clearing database...\n');

const dbPath = process.env.DB_PATH;
if (!dbPath) {
  console.error('❌ DB_PATH environment variable is required');
  process.exit(1);
}

try {
  console.log(`📁 Database path: ${dbPath}`);
  
  // Connect to the database
  const db = new Database(dbPath);
  
  // Get current table information
  const tables = db.prepare(`
    SELECT name FROM sqlite_master 
    WHERE type='table' AND name NOT LIKE 'sqlite_%'
  `).all();
  
  console.log(`📊 Found ${tables.length} tables: ${tables.map(t => t.name).join(', ')}`);
  
  if (tables.length === 0) {
    console.log('✅ Database is already empty');
    db.close();
    process.exit(0);
  }
  
  // Disable foreign key constraints temporarily
  db.pragma('foreign_keys = OFF');
  
  // Drop all tables
  console.log('\n🗑️  Dropping tables...');
  for (const table of tables) {
    console.log(`   Dropping table: ${table.name}`);
    db.prepare(`DROP TABLE IF EXISTS ${table.name}`).run();
  }
  
  // Re-enable foreign key constraints
  db.pragma('foreign_keys = ON');
  
  // Verify tables are gone
  const remainingTables = db.prepare(`
    SELECT name FROM sqlite_master 
    WHERE type='table' AND name NOT LIKE 'sqlite_%'
  `).all();
  
  if (remainingTables.length === 0) {
    console.log('✅ All tables dropped successfully');
  } else {
    console.log(`⚠️  Warning: ${remainingTables.length} tables still exist: ${remainingTables.map(t => t.name).join(', ')}`);
  }
  
  // Close the database connection
  db.close();
  
  console.log('\n🎉 Database cleared successfully!');
  console.log('\n💡 Next steps:');
  console.log('   1. Restart your server to recreate tables');
  console.log('   2. Run: npm run dev');
  console.log('   3. Tables will be automatically recreated when the server starts');
  
} catch (error) {
  console.error('❌ Error clearing database:', error.message);
  process.exit(1);
} 