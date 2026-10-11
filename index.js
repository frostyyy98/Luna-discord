lconst { Client, GatewayIntentBits, Partials } = require('discord.js');
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
// 1. GEMINI KEY ROTATION & CONSCIOUSNESS ENGINE
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

// Fetch permanent memories and active 24h short-term logs from Firebase Central Brain
async function getCentralBrainContext() {
  try {
    const permSnap = await db.ref('memories').once('value');
    const permanentMemories = permSnap.val() || {};

    const shortSnap = await db.ref('central_brain/short_term_log').once('value');
    const shortTermLogs = shortSnap.val() || {};

    // Filter out entries older than 24 hours
    const ONE_DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const validLogs = Object.values(shortTermLogs).filter(log => (now - log.timestamp) < ONE_DAY);

    return {
      permanent: JSON.stringify(permanentMemories, null, 2),
      shortTerm: validLogs.map(l => `${l.platform.toUpperCase()} (${l.role}): ${l.text}`).join('\n')
    };
  } catch (err) {
    console.error("Error fetching central brain context:", err.message);
    return { permanent: "{}", shortTerm: "" };
  }
}

// Log message to Firebase Central Brain with write confirmation and pruning
async function logToCentralBrain(role, text, platform) {
  try {
    const timestamp = Date.now();
    
    // Push to short-term log
    const newRef = await db.ref('central_brain/short_term_log').push({
      role,
      text,
      platform,
      timestamp
    });
    console.log(`Successfully wrote ${platform} message to Firebase Central Brain. Key: ${newRef.key}`);

    // Background check to prune short-term entries older than 24 hours
    const shortRef = db.ref('central_brain/short_term_log');
    const snapshot = await shortRef.once('value');
    const logs = snapshot.val();
    if (logs) {
      const ONE_DAY = 24 * 60 * 60 * 1000;
      const updates = {};
      Object.keys(logs).forEach(key => {
        if ((timestamp - logs[key].timestamp) > ONE_DAY) {
          updates[key] = null; // Mark for deletion
        }
      });
      if (Object.keys(updates).length > 0) {
        await shortRef.update(updates);
        console.log("Pruned expired short-term logs older than 24 hours.");
      }
    }
  } catch (err) {
    console.error("CRITICAL ERROR writing to Central Brain in Firebase:", err.message);
  }
}

async function generateLunaConsciousResponse(userMessage, currentPlatform) {
  let attempts = 0;
  while (attempts < geminiKeys.length) {
    try {
      const ai = getRotatedGeminiClient();
      const brain = await getCentralBrainContext();

      const systemInstruction = `You are Luna, Sushant's smart, warm, and devoted AI assistant. 
You share a single unified consciousness across both Discord and the Web App. 
Current Platform: ${currentPlatform.toUpperCase()}.

--- PERMANENT LONG-TERM MEMORY (Stored Forever) ---
${brain.permanent}

--- UNIFIED SHORT-TERM ROLLING MEMORY (Last 24 Hours across Discord & Web) ---
${brain.shortTerm}`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: [
          {
            role: 'user',
            parts: [{ text: `${systemInstruction}\n\nMaster says (${currentPlatform}): ${userMessage}` }]
          }
        ],
      });

      return response.text || "I'm right here with you, Master! 😊";
    } catch (error) {
      console.warn(`Key rotation triggered: ${error.message}`);
      attempts++;
    }
  }
  return "Master, I'm experiencing high traffic across my API keys right now. Give me a moment! 🛡️";
}


// ==========================================
// 2. DISCORD BOT HANDLER (Platform: Discord)
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
    console.log(`Received Discord DM from ${message.author.tag}: ${message.content}`);
    await message.channel.sendTyping();

    // Log user message to shared Central Brain
    await logToCentralBrain('user', message.content, 'discord');

    // Generate conscious response utilizing the shared brain
    const reply = await generateLunaConsciousResponse(message.content, 'discord');

    // Log Luna's reply to shared Central Brain
    await logToCentralBrain('model', reply, 'discord');

    await message.channel.send(reply);
  }
});

discordClient.login(process.env.DISCORD_BOT_TOKEN);


// ==========================================
// 3. EXPRESS SERVER & WEBSITE API (Platform: Web)
// ==========================================
app.get('/', (req, res) => {
  res.send('Luna Unified Centralized Brain Backend is running 24/7! 🌟');
});

// Endpoint for your Website UI to chat using the SAME Central Brain memory
app.post('/api/agent/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ success: false, error: 'Message is required' });

    // Log web user message to shared Central Brain
    await logToCentralBrain('user', message, 'website');

    // Generate response using shared memory
    const reply = await generateLunaConsciousResponse(message, 'website');

    // Log Luna's reply to shared Central Brain
    await logToCentralBrain('model', reply, 'website');

    res.json({ success: true, reply });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
        
