const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { GoogleGenAI } = require('@google/genai');
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');

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
// 1. GEMINI KEY ROTATION & FALLBACK ENGINE
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

async function processAndStoreMemory(senderRole, messageText, platform) {
  try {
    const timestamp = Date.now();
    const cleanPlatform = platform.toLowerCase() === 'discord' ? 'disc' : (platform.toLowerCase() === 'instagram' ? 'insta' : 'web');
    
    await db.ref('central_brain/short_term_log').push({
      r: senderRole,
      t: messageText,
      p: cleanPlatform,
      timestamp: timestamp
    });

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
          // Ignore JSON parse errors
        }
      }
    }

    // Cleanup short-term logs older than 24 hours
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

  const systemInstruction = `You are Luna, Sushant's smart, warm, and devoted AI assistant sharing a unified consciousness across Discord, Instagram, and Web.
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
// 3. DISCORD BOT HANDLER
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
    await processAndStoreMemory('user', message.content, 'discord');
    const reply = await generateLunaConsciousResponse(message.content, 'discord');
    await processAndStoreMemory('model', reply, 'discord');
    await message.channel.send(reply);
  }
});

discordClient.login(process.env.DISCORD_BOT_TOKEN);

// ==========================================
// 4. INSTAGRAM WEBHOOK HANDLERS
// ==========================================

// Meta Webhook Verification
app.get('/api/instagram/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.INSTAGRAM_VERIFY_TOKEN || 'luna_secret_verify_2026';
  
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[Instagram] Webhook verified successfully!');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Incoming Instagram DM Event Listener
app.post('/api/instagram/webhook', (req, res) => {
  // 1. Instantly respond 200 OK to Meta to acknowledge receipt
  res.status(200).send('EVENT_RECEIVED');

  const body = req.body;

  // 2. Process message asynchronously in background
  if (body.object === 'instagram' || body.object === 'page') {
    (async () => {
      for (const entry of body.entry || []) {
        if (!entry.messaging) continue;
        
        for (const messagingEvent of entry.messaging) {
          if (messagingEvent.message && messagingEvent.message.text && !messagingEvent.message.is_echo) {
            const senderId = messagingEvent.sender.id;
            const userMessage = messagingEvent.message.text;

            console.log(`[Instagram DM] Received from ${senderId}: ${userMessage}`);

            try {
              await processAndStoreMemory('user', userMessage, 'instagram');
              const reply = await generateLunaConsciousResponse(userMessage, 'instagram');
              await processAndStoreMemory('model', reply, 'instagram');
              await replyToInstagramUser(senderId, reply);
            } catch (err) {
              console.error('[Instagram DM] Error processing message:', err.message);
            }
          }
        }
      }
    })();
  }
});

// Helper: Send DM reply via Meta Graph API
async function replyToInstagramUser(recipientId, text) {
  const token = process.env.INSTAGRAM_PAGE_ACCESS_TOKEN || process.env.INSTAGRAM_ACCESS_TOKEN;
  
  try {
    await axios.post(
      `https://graph.instagram.com/v22.0/me/messages`,
      {
        recipient: { id: recipientId },
        message: { text: text },
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log('[Instagram DM] Reply sent successfully!');
  } catch (error) {
    console.error('[Instagram DM API Error]:', error.response?.data || error.message);
  }
}

// ==========================================
// 5. EXPRESS SERVER & WEBSITE API
// ==========================================
app.get('/', (req, res) => {
  res.send('Luna Unified Centralized Brain Backend is running 24/7! 🌟');
});

app.post('/api/agent/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ success: false, error: 'Message is required' });

    await processAndStoreMemory('user', message, 'website');
    const reply = await generateLunaConsciousResponse(message, 'website');
    await processAndStoreMemory('model', reply, 'website');

    res.json({ success: true, reply });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
  
