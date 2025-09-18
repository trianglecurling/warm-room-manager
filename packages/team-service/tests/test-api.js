// Simple test script to demonstrate the API functionality
// Run with: node tests/test-api.js

import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}/api`;

async function testAPI() {
  console.log('🧪 Testing Curling Team API...\n');

  try {
    // Test 1: Create a context and team
    console.log('1️⃣ Creating a team...');
    const createTeamResponse = await fetch(`${BASE_URL}/teams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        teamName: 'Team Smith',
        contextName: 'Tuesday League',
        contextType: 'league',
        contextStartDate: '2024-01-15T18:00:00Z',
        contextEndDate: '2024-03-15T22:00:00Z',
        lead: 'John Doe',
        second: 'Jane Smith',
        third: 'Bob Johnson',
        fourth: 'Alice Brown',
        vicePosition: 'third',
        skipPosition: 'fourth',
        homeClub: 'Downtown Curling Club'
      })
    });
    
    const team = await createTeamResponse.json();
    console.log('✅ Team created:', team.data?.teamName);

    // Test 2: Get all contexts
    console.log('\n2️⃣ Getting all contexts...');
    const contextsResponse = await fetch(`${BASE_URL}/contexts`);
    const contexts = await contextsResponse.json();
    console.log('✅ Contexts found:', contexts.data?.length || 0);

    // Test 3: Get teams for context
    console.log('\n3️⃣ Getting teams for Tuesday League...');
    const teamsResponse = await fetch(`${BASE_URL}/teams/Tuesday%20League`);
    const teams = await teamsResponse.json();
    console.log('✅ Teams found:', teams.data?.length || 0);

    // Test 4: Search for teams
    console.log('\n4️⃣ Searching for teams with "smith"...');
    const searchResponse = await fetch(`${BASE_URL}/search?contextName=Tuesday%20League&q=smith`);
    const searchResults = await searchResponse.json();
    console.log('✅ Search results:', searchResults.data?.length || 0);

    // Test 5: Update a team
    console.log('\n5️⃣ Updating team...');
    const updateResponse = await fetch(`${BASE_URL}/teams/Tuesday%20League/Team%20Smith`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        homeClub: 'Updated Downtown Curling Club'
      })
    });
    const updatedTeam = await updateResponse.json();
    console.log('✅ Team updated:', updatedTeam.data?.homeClub);

    // Test 6: Bulk create teams
    console.log('\n6️⃣ Bulk creating teams...');
    const bulkResponse = await fetch(`${BASE_URL}/teams/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        format: 'teamName, lead, second, third, fourth, homeClub',
        data: [
          ['Team Alpha', 'Alice Wilson', 'Bob Davis', 'Carol Lee', 'David Taylor', 'Downtown Club'],
          ['Team Beta', 'Eve Johnson', 'Frank White', 'Grace Brown', 'Henry Miller', 'Uptown Club']
        ],
        contextName: 'Spring Tournament',
        contextType: 'tournament',
        contextStartDate: '2024-04-01T09:00:00Z',
        contextEndDate: '2024-04-03T18:00:00Z'
      })
    });
    const bulkResults = await bulkResponse.json();
    console.log('✅ Bulk teams created:', bulkResults.data?.length || 0);

    // Test 7: Get specific team
    console.log('\n7️⃣ Getting specific team...');
    const specificTeamResponse = await fetch(`${BASE_URL}/teams/Tuesday%20League/Team%20Smith`);
    const specificTeam = await specificTeamResponse.json();
    console.log('✅ Team details:', specificTeam.data?.teamName);

    console.log('\n🎉 All tests completed successfully!');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

// Run tests if this file is executed directly
testAPI(); 