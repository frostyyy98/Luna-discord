const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
const admin = require('firebase-admin');
const axios = require('axios');

// --- 1. Express Setup for Render 24/7 Uptime ---
const app = express();
app.get('/', (req, res) => res.send('Luna Discord Bot is active!'));
app.listen(process.env.PORT || 3000, () => console.log('Web health-check server running.'));

// --- 2. Firebase Initialization ---
const firebaseConfig = {
  databaseURL: "https://luna-7208f-default-rtdb.firebaseio.com"
};

admin.initializeApp({
  credential: admin.credential.cert(require('./serviceAccountKey.json')),
  databaseURL: firebaseConfig.databaseURL
});
const db = admin.database();

// --- 3. Groq API Keys & Rotation System (From Environment Variables) ---
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

// --- 4. Library Memory System Handlers ---
async function fetchLibraryContext() {
  const snapshot = await db.ref('memories').once('value');
  const data = snapshot.val();
  if (!data) return "No stored library memories yet.";

  let contextString = "SYSTEM LIBRARY CONTEXT:\n";
  Object.keys(data).forEach(category => {
    if (data[category]) {
      Object.values(data[category]).forEach(item => {
        if (item && item.d) {
          contextString += `- [${category.toUpperCase()}] ${item.d}\n`;
        }
      });
    }
  });
  return contextString;
}

async function extractAndSaveMemory(userMessage) {
  try {
    const prompt = `Analyze this message. If it contains explicit user preferences, identity info, goals, or project notes, extract it.
Return ONLY valid JSON format like this: {"t": "Title", "d": "Compressed statement under 120 chars", "c": "preferences", "p": "HIGH"} 
If irrelevant, return: {"irrelevant": true}
Message: "${userMessage}"`;

    const data = await makeGroqRequest({
      model: "qwen/qwen3.8-27b",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1
    });

    const content = data.choices[0].message.content;
    const parsed = JSON.parse(content.replace(/```json/g, '').replace(/```/g, '').trim());

    if (!parsed.irrelevant && parsed.d) {
      const category = parsed.c || 'general';
      const newRef = db.ref(`memories/${category}`).push();
      await newRef.set({
        t: parsed.t || 'Memory',
        d: parsed.d,
        p: parsed.p || 'MED',
        ts: Date.now()
      });
      console.log(`[Memory Saved] (${category}): ${parsed.d}`);
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
    GatewayIntentBits.MessageContent
  ]
});

client.once('ready', () => {
  console.log(`Luna Discord Bot logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // Run memory extraction in the background (non-blocking)
  extractAndSaveMemory(message.content);

  try {
    await message.channel.sendTyping();

    const libraryContext = await fetchLibraryContext();

    const systemPrompt = `You are Luna, a helpful, high-performance personal AI companion. Use the following dynamic memory library database to ground your answers in user facts:
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

// Login using environment variable for token
client.login(process.env.DISCORD_TOKEN);
                     
