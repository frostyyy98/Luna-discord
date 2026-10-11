const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { google } = require('googleapis');
const { GoogleGenAI } = require('@google/genai');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// 1. GEMINI API KEY ROTATION MANAGER
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

async function generateLunaResponse(promptText) {
  let attempts = 0;
  while (attempts < geminiKeys.length) {
    try {
      const ai = getRotatedGeminiClient();
      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: [
          {
            role: 'user',
            parts: [{ text: `You are Luna, Sushant's smart, warm, and friendly AI assistant. Reply naturally and helpfully. Context/Message: ${promptText}` }]
          }
        ],
      });
      return response.text || "I'm here, Master! 😊 What's on your mind?";
    } catch (error) {
      console.warn(`Gemini key error encountered, rotating key... Error: ${error.message}`);
      attempts++;
    }
  }
  return "Master, I'm currently experiencing high traffic across my API keys. Give me just a moment! 🛡️";
}


// ==========================================
// 2. DISCORD BOT SETUP (DMs & Chat)
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

  // Handle Private Direct Messages
  if (!message.guild) {
    console.log(`Received private DM from ${message.author.tag}: ${message.content}`);
    await message.channel.sendTyping();

    const lunaReply = await generateLunaResponse(message.content);
    await message.channel.send(lunaReply);
  }
});

discordClient.login(process.env.DISCORD_BOT_TOKEN);


// ==========================================
// 3. GMAIL ASSISTANT BACKGROUND LOOP
// ==========================================
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

oauth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN
});

const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
const PROCESSED_IDS = new Set();

function isPersonalEmail(sender, subject, body) {
  const text = (subject + " " + body).toLowerCase();
  const lowSender = sender.toLowerCase();

  if (lowSender.includes("noreply") || lowSender.includes("no-reply") || lowSender.includes("donotreply")) return false;
  if (text.includes("otp") || text.includes("verification code") || text.includes("security code") || text.includes("invoice")) return false;
  
  return true;
}

async function checkAndManageEmails() {
  try {
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread category:primary',
      maxResults: 3
    });

    const messages = listRes.data.messages || [];
    for (const msg of messages) {
      if (PROCESSED_IDS.has(msg.id)) continue;
      PROCESSED_IDS.add(msg.id);

      const fullMsg = await gmail.users.messages.get({ userId: 'me', id: msg.id });
      const headers = fullMsg.data.payload.headers;
      const sender = headers.find(h => h.name === 'From')?.value || '';
      const subject = headers.find(h => h.name === 'Subject')?.value || '';
      const body = fullMsg.data.snippet || '';

      if (!isPersonalEmail(sender, subject, body)) {
        console.log(`Skipping non-personal mail from: ${sender}`);
        continue;
      }

      console.log(`New personal mail detected from ${sender}. Generating Gemini response...`);
      
      const emailPrompt = `An email was received from ${sender} with Subject: "${subject}" and Body snippet: "${body}". Write a polite, intelligent reply as Luna.`;
      const lunaEmailReply = await generateLunaResponse(emailPrompt);

      console.log(`Generated reply for email: ${lunaEmailReply}`);
    }
  } catch (error) {
    console.error("Gmail background loop error:", error.message);
  }
}

// Check emails every 3 minutes in the background
setInterval(checkAndManageEmails, 3 * 60 * 1000);


// ==========================================
// 4. EXPRESS SERVER (Keeps Render Alive)
// ==========================================
app.get('/', (req, res) => {
  res.send('Luna Unified Backend (Discord Bot + Gemini 3.8 Flash + Gmail) is running 24/7! 🌟');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
              
