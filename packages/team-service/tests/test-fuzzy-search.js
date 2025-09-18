// Test script to demonstrate fuzzy search functionality
// Run with: node tests/test-fuzzy-search.js

import dotenv from 'dotenv';

dotenv.config();

const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}/api`;

console.log("Base URL: ", BASE_URL);

async function testFuzzySearch() {
  console.log('🔍 Testing Fuzzy Search API...\n');

  try {
    // First, create some test teams with various name patterns
    console.log('1️⃣ Creating test teams...');
    
    const testTeams = [
      {
        teamName: "Team O'Reilly",
        contextName: "Test League",
        contextType: "league",
        contextStartDate: "2024-01-15T18:00:00Z",
        contextEndDate: "2024-03-15T22:00:00Z",
        lead: "John Smith",
        second: "Jane Doe",
        third: "Bob Johnson",
        fourth: "Kenneth O'Reilly",
        vicePosition: "third",
        skipPosition: "fourth",
        homeClub: "Downtown Curling Club"
      },
      {
        teamName: "Team MacDonald",
        contextName: "Test League",
        contextType: "league",
        contextStartDate: "2024-01-15T18:00:00Z",
        contextEndDate: "2024-03-15T22:00:00Z",
        lead: "Alice Wilson",
        second: "Frank Davis",
        third: "Grace Lee",
        fourth: "Michael MacDonald",
        vicePosition: "third",
        skipPosition: "fourth",
        homeClub: "Uptown Curling Club"
      },
      {
        teamName: "Team van der Berg",
        contextName: "Test League",
        contextType: "league",
        contextStartDate: "2024-01-15T18:00:00Z",
        contextEndDate: "2024-03-15T22:00:00Z",
        lead: "Sarah Johnson",
        second: "Tom Brown",
        third: "Lisa White",
        fourth: "Pieter van der Berg",
        vicePosition: "third",
        skipPosition: "fourth",
        homeClub: "International Curling Club"
      }
    ];

    for (const teamData of testTeams) {
      try {
        const response = await fetch(`${BASE_URL}/teams`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(teamData)
        });
        
        const result = await response.json();
        
        if (response.ok) {
          console.log(`✅ Created: ${result.data?.teamName}`);
        } else {
          console.log(`❌ Failed to create team: ${teamData.teamName}`);
          console.log(`   Error: ${result.error}`);
        }
      } catch (error) {
        console.log(`❌ Error creating team ${teamData.teamName}: ${error.message}`);
      }
    }

    // Test various fuzzy search queries
    console.log('\n2️⃣ Testing fuzzy search queries...');
    
    const searchTests = [
      { query: "oreilly", description: "Fuzzy match for 'Kenneth O'Reilly'" },
      { query: "macdonald", description: "Fuzzy match for 'Michael MacDonald'" },
      { query: "vanderberg", description: "Fuzzy match for 'Pieter van der Berg'" },
      { query: "ken", description: "Partial match for 'Kenneth'" },
      { query: "michael", description: "First name match" },
      { query: "downtown", description: "Club name match" },
      { query: "johnson", description: "Multiple player match" },
      { query: "team", description: "Team name prefix" },
      { query: "xyz", description: "No match expected" }
    ];

    for (const test of searchTests) {
      console.log(`\n🔍 Testing: "${test.query}" - ${test.description}`);
      
      const searchResponse = await fetch(`${BASE_URL}/search?contextName=Test%20League&q=${encodeURIComponent(test.query)}`);
      const searchResults = await searchResponse.json();
      
      if (searchResults.success && searchResults.data) {
        console.log(`✅ Found ${searchResults.data.length} results:`);
        searchResults.data.forEach((result, index) => {
          console.log(`   ${index + 1}. ${result.team.teamName} (${result.matchType}, relevance: ${result.relevance})`);
        });
      } else {
        console.log(`❌ Search failed: ${searchResults.error}`);
      }
    }

    console.log('\n🎉 Fuzzy search tests completed!');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

// Run tests if this file is executed directly
testFuzzySearch(); 