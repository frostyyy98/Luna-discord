const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
const admin = require('firebase-admin');
const axios = require('axios');

// --- 1. Express Setup for Render 24/7 Uptime ---
const app = express();
app.get('/', (req, res) => res.send('Luna Discord Bot is active!'));
app.listen(process.env.PORT || 3000, () => console.log('Web health-check server running.'));

// --- 2. Firebase Initialization ---
let serviceAccount;
try {
  let rawCreds = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
  if (rawCreds.startsWith("'") && rawCreds.endsWith("'")) {
    rawCreds = rawCreds.slice(1, -1);
  }
  serviceAccount = JSON.parse(rawCreds);
} catch (e) {
  console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT env var. Ensure it is valid JSON.", e);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://luna-7208f-default-rtdb.firebaseio.com"
});
const db = admin.database();

// --- 3. Groq API Keys & Rotation System ---
const groqKeys = process.env.GROQ_KEYS ? process.env.GROQ_KEYS.split(',') : [];
let currentKeyIndex = 0;

function getRotatedKey() {
  if (groqKeys.length === 0) throw new Error("No Groq keys found in environment variables!");
  return groqKeys[currentKeyIndex].trim();
}

function rotateKey() {
  currentKeyIndex = (currentKeyIndex + 1) % groqKeys.length;
  console.log(`Rate limit or error hit. Rotating to Groq Key Index: ${currentKeyIndex}`);
}

async function makeGroqRequest(payload) {
  let attempts = 0;
  while (attempts < groqKeys.length) {
    try {
      const apiKey = getRotatedKey();
      const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', payload, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      });
      return response.data;
    } catch (error) {
      const status = error.response ? error.response.status : null;
      if (status === 429 || status === 401 || status === 403) {
        rotateKey();
        attempts++;
      } else {
        throw error;
      }
    }
  }
  throw new Error('All Groq API keys have been exhausted or hit rate limits.');
}

// --- 4. Cross-Platform Universal Memory System ---

// Universal Retrieval: Reads both Web Luna (mem_...) and nested category structures
async function fetchLibraryContext() {
  try {
    const snapshot = await db.ref('memories').once('value');
    const data = snapshot.val();
    if (!data) return "No stored library memories yet.";

    let contextString = "SHARED USER MEMORY LIBRARY:\n";

    Object.keys(data).forEach(key => {
      const item = data[key];
      if (item) {
        // If it's a flat memory object (Web Luna style)
        if (item.d) {
          const category = item.c ? item.c.toUpperCase() : 'GENERAL';
          contextString += `- [${category}] ${item.d}\n`;
        } 
        // If it's a nested category node
        else if (typeof item === 'object') {
          Object.values(item).forEach(subItem => {
            if (subItem && subItem.d) {
              const category = subItem.c ? subItem.c.toUpperCase() : key.toUpperCase();
              contextString += `- [${category}] ${subItem.d}\n`;
            }
          });
        }
      }
    });

    return contextString;
  } catch (err) {
    console.error("Error fetching library context:", err.message);
    return "Error loading memories.";
  }
}

// Universal Saver: Saves personal facts directly in Web Luna's memory format
async function extractAndSaveMemory(userMessage) {
  try {
    const prompt = `Analyze this message. If it contains ANY personal facts about the user (such as pets, names, hobbies, preferences, identity info, goals, or project notes), extract it.
Return ONLY a raw JSON object without any markdown formatting or extra text: {"t": "Title", "d": "Compressed statement under 120 chars", "c": "preferences", "p": "medium"} 
If completely irrelevant (like chit-chat or casual greetings), return: {"irrelevant": true}
Message: "${userMessage}"`;

    const data = await makeGroqRequest({
      model: "qwen/qwen3.8-27b",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1
    });

    const rawContent = data.choices[0].message.content;
    let cleanContent = rawContent.trim();
    if (cleanContent.startsWith('```json')) {
      cleanContent = cleanContent.replace(/^```json/, '').replace(/```$/, '').trim();
    } else if (cleanContent.startsWith('```')) {
      cleanContent = cleanContent.replace(/^```/, '').replace(/```$/, '').trim();
    }

    const parsed = JSON.parse(cleanContent);

    if (!parsed.irrelevant && parsed.d) {
      const memoryId = `mem_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      
      await db.ref(`memories/${memoryId}`).set({
        t: parsed.t || 'Memory',
        d: parsed.d,
        c: parsed.c || 'general',
        p: parsed.p || 'medium',
        src: 'chatextraction',
        ts: Date.now()
      });
      
      console.log(`[Memory Saved & Synced] (${parsed.c}): ${parsed.d}`);
    }
  } catch (err) {
    console.error('Memory extraction error:', err.message);
  }
}

// --- 5. Discord Bot Initialization ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once('ready', () => {
  console.log(`Luna Discord Bot logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // Run memory extraction on every incoming user message
  extractAndSaveMemory(message.content);

  try {
    await message.channel.sendTyping();

    // Pull full shared memory context from Firebase
    const libraryContext = await fetchLibraryContext();

    const systemPrompt = `You are Luna, a helpful, high-performance personal AI companion. 
CRITICAL RULE: You have access to a Shared User Memory Library below. This library contains absolute facts about the user across all platforms. When the user asks a question about themselves (like their name, pets, favorites, or projects), you MUST check this library and answer using those facts. Never claim you don't know something if it is listed in the library.

${libraryContext}`;

    const chatResponse = await makeGroqRequest({
      model: "qwen/qwen3.8-27b",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message.content }
      ],
      temperature: 0.7
    });

    const replyText = chatResponse.choices[0].message.content;
    await message.reply(replyText);

  } catch (err) {
    console.error('Chat response error:', err.message);
    await message.reply("Oops! I encountered an error running through my key rotation system. Please try again.");
  }
});

client.login(process.env.DISCORD_TOKEN);
  
