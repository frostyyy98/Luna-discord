const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
const admin = require('firebase-admin');
const axios = require('axios');

// --- 1. Express Setup for Render 24/7 Uptime ---
const app = express();
app.get('/', (req, res) => res.send('Luna Discord Bot is active!'));
app.listen(process.env.PORT || 3000, () => console.log('Web health-check server running.'));

// --- 2. Firebase Initialization (Robust Parser) ---
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
Return ONLY a raw JSON object without any markdown formatting or extra text: {"t": "Title", "d": "Compressed statement under 120 chars", "c": "preferences", "p": "HIGH"} 
If irrelevant, return: {"irrelevant": true}
Message: "${userMessage}"`;

    const data = await makeGroqRequest({
      model: "qwen/qwen3.8-27b",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1
    });

    const rawContent = data.choices[0].message.content;
    console.log("[Raw Extraction Response]:", rawContent);

    let cleanContent = rawContent.trim();
    if (cleanContent.startsWith('```json')) {
      cleanContent = cleanContent.replace(/^```json/, '').replace(/```$/, '').trim();
    } else if (cleanContent.startsWith('```')) {
      cleanContent = cleanContent.replace(/^```/, '').replace(/```$/, '').trim();
    }

    const parsed = JSON.parse(cleanContent);

    if (!parsed.irrelevant && parsed.d) {
      const category = parsed.c || 'general';
      const newRef = db.ref(`memories/${category}`).push();
      await newRef.set({
        t: parsed.t || 'Memory',
        d: parsed.d,
        p: parsed.p || 'MED',
        ts: Date.now()
      });
      console.log(`[Memory Saved Successfully] (${category}): ${parsed.d}`);
    } else {
      console.log("[Memory Skipped] Message deemed irrelevant.");
    }
  } catch (err) {
    console.error('Memory extraction error details:', err.message);
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

client.login(process.env.DISCORD_TOKEN);
