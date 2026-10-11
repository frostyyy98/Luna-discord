const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { GoogleGenAI } = require('@google/genai');
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}
const db = admin.database();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ==========================================
// 1. GEMINI KEY ROTATION & HIGH-TRAFFIC FALLBACK ENGINE
// Primary: gemini-3.8-flash | Fallback: gemini-3.6-flash
// ==========================================
const apiKeysEnv = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
const geminiKeys = apiKeysEnv.split(',').map(k => k.trim()).filter(Boolean);
let currentKeyIndex = 0;

function getRotatedGeminiClient() {
  if (geminiKeys.length === 0) {
    throw new Error("No Gemini API keys found in environment variables!");
  }
  const apiKey = geminiKeys[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % geminiKeys.length;
  return new GoogleGenAI({ apiKey });
}

async function generateWithTrafficFallback(promptText) {
  const modelsToTry = ['gemini-3.8-flash', 'gemini-3.6-flash'];

  for (const model of modelsToTry) {
    let attempts = 0;
    const maxAttempts = Math.max(geminiKeys.length, 1);

    while (attempts < maxAttempts) {
      try {
        const ai = getRotatedGeminiClient();
        const response = await ai.models.generateContent({
          model: model,
          contents: [{ role: 'user', parts: [{ text: promptText }] }],
        });

        if (response && response.text) {
          return response.text;
        }
      } catch (error) {
        attempts++;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }
  return null;
}

// ==========================================
// 2. CENTRAL BRAIN & MEMORY AUTOMATION
// ==========================================
async function getCentralBrainContext() {
  try {
    const permSnap = await db.ref('memories').once('value');
    const permanentMemories = permSnap.val() || {};

    const shortSnap = await db.ref('central_brain/short_term_log').once('value');
    const shortTermLogs = shortSnap.val() || {};

    const ONE_DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    
    // Compact, readable format for context injection
    const validLogs = Object.values(shortTermLogs)
      .filter(log => (now - log.timestamp) < ONE_DAY)
      .map(l => `[${l.p}] ${l.r === 'user' ? 'M' : 'L'}: ${l.t}`);

    return {
      permanent: JSON.stringify(permanentMemories, null, 2),
      shortTerm: validLogs.join('\n')
    };
  } catch (err) {
    console.error("Error fetching central brain context:", err.message);
    return { permanent: "{}", shortTerm: "" };
  }
}

// Streamlined storage-friendly short-term logging + Permanent Fact Extraction
async function processAndStoreMemory(senderRole, messageText, platform) {
  try {
    const timestamp = Date.now();
    const cleanPlatform = platform.toLowerCase() === 'discord' ? 'disc' : 'web';
    
    // 1. Compact storage entry for short-term log
    await db.ref('central_brain/short_term_log').push({
      r: senderRole,          // 'user' or 'model'
      t: messageText,         // message text
      p: cleanPlatform,       // 'disc' or 'web'
      timestamp: timestamp
    });

    // 2. If it's a user message, check if it contains a permanent fact worth saving forever
    if (senderRole === 'user') {
      const analysisPrompt = `Analyze this user message: "${messageText}". 
Does it contain a core personal fact, preference, relationship note, project rule, or milestone that should be remembered FOREVER? 
If yes, output ONLY a JSON object with this exact format: {"save": true, "category": "category_name", "fact": "short factual statement"}.
If no, output ONLY: {"save": false}`;

      const analysisResult = await generateWithTrafficFallback(analysisPrompt);
      if (analysisResult) {
        const cleanedJson = analysisResult.replace(/```json/g, '').replace(/```/g, '').trim();
        try {
          const parsed = JSON.parse(cleanedJson);
          if (parsed && parsed.save && parsed.fact) {
            const category = parsed.category || 'general_facts';
            await db.ref(`memories/${category}`).push({
              fact: parsed.fact,
              sourcePlatform: platform.toLowerCase(),
              timestamp: new Date().toISOString()
            });
          }
        } catch (jsonErr) {
          // Ignore parse errors if model returns unstructured text
        }
      }
    }

    // 3. Automated background cleanup of logs older than 24 hours
    const shortRef = db.ref('central_brain/short_term_log');
    const snapshot = await shortRef.once('value');
    const logs = snapshot.val();
    if (logs) {
      const ONE_DAY = 24 * 60 * 60 * 1000;
      const updates = {};
      Object.keys(logs).forEach(key => {
        if ((timestamp - logs[key].timestamp) > ONE_DAY) {
          updates[key] = null;
        }
      });
      if (Object.keys(updates).length > 0) {
        await shortRef.update(updates);
      }
    }
  } catch (err) {
    console.error("Error in memory processing router:", err.message);
  }
}

async function generateLunaConsciousResponse(userMessage, currentPlatform) {
  const brain = await getCentralBrainContext();

  const systemInstruction = `You are Luna, Sushant's smart, warm, and devoted AI assistant sharing a unified consciousness across Discord and Web.
Platform: ${currentPlatform.toUpperCase()}.

--- PERMANENT MEMORY ---
${brain.permanent}

--- SHORT-TERM LOG (Last 24h) ---
${brain.shortTerm}

Master says (${currentPlatform}): ${userMessage}`;

  const reply = await generateWithTrafficFallback(systemInstruction);
  return reply || "I'm right here with you, Master! 😊";
}


// ==========================================
// 3. DISCORD BOT HANDLER (Platform: Discord)
// ==========================================
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message]
});

discordClient.on('ready', () => {
  console.log(`Luna Discord Bot logged in as ${discordClient.user.tag} 🚀`);
});

discordClient.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (!message.guild) {
    await message.channel.sendTyping();

    // Store user message to compact short-term log & check permanent facts
    await processAndStoreMemory('user', message.content, 'discord');

    // Generate conscious response
    const reply = await generateLunaConsciousResponse(message.content, 'discord');

    // Store Luna's reply to compact short-term log
    await processAndStoreMemory('model', reply, 'discord');

    await message.channel.send(reply);
  }
});

discordClient.login(process.env.DISCORD_BOT_TOKEN);


// ==========================================
// 4. EXPRESS SERVER & WEBSITE API (Platform: Web)
// ==========================================
app.get('/', (req, res) => {
  res.send('Luna Unified Centralized Brain Backend is running 24/7! 🌟');
});

app.post('/api/agent/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ success: false, error: 'Message is required' });

    // Store web user message to compact short-term log & check permanent facts
    await processAndStoreMemory('user', message, 'website');

    // Generate conscious response
    const reply = await generateLunaConsciousResponse(message, 'website');

    // Store Luna's reply to compact short-term log
    await processAndStoreMemory('model', reply, 'website');

    res.json({ success: true, reply });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
      
