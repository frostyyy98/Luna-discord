const { Client, GatewayIntentBits, Partials } = require('discord.js');
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
// 2. DISCORD BOT SETUP (DMs & Server Chat)
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
// 3. EXPRESS SERVER (Keeps Render Web Service Alive)
// ==========================================
app.get('/', (req, res) => {
  res.send('Luna Discord Bot is running 24/7 on Render! 🌟');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
