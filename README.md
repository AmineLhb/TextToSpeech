# Discord Text-to-Speech (TTS) Bot 🗣️

A Discord bot that joins your voice channel when you use `/say [text]`, speaks your message out loud using Google Text-to-Speech, and immediately disconnects after finishing.

## 📁 Project Location
`C:\Users\DELL LATITUDE 5450\.gemini\antigravity\scratch\discord-tts-bot`

---

## 🚀 Quick Setup Instructions

### 1. Create your Bot in Discord Developer Portal
1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **"New Application"**, give it a name (e.g. `TTS Bot`), and click **Create**.
3. In the left menu, go to **Bot**:
   * Click **Reset Token** (or **Copy**) to get your **Bot Token**.
   * Under **Privileged Gateway Intents**, turn **ON**:
     * `Server Members Intent`
     * `Message Content Intent`
4. Click **Save Changes**.

### 2. Add your Token to the Bot
1. Open the file:
   [`.env`](file:///C:/Users/DELL%20LATITUDE%205450/.gemini/antigravity/scratch/discord-tts-bot/.env)
2. Replace `your_bot_token_here` with your copied token:
   ```env
   DISCORD_TOKEN=MTE5...
   ```
3. Save the file.

### 3. Invite the Bot to Your Server
1. In the Developer Portal, go to **OAuth2** > **URL Generator**.
2. Under **Scopes**, select:
   * `bot`
   * `applications.commands`
3. Under **Bot Permissions**, select:
   * `Send Messages`
   * `Connect`
   * `Speak`
   * `Use Slash Commands`
4. Copy the generated URL at the bottom and open it in your browser to add the bot to your server (**Tarnished souls**).

### 4. Run the Bot
Double-click [`run.bat`](file:///C:/Users/DELL%20LATITUDE%205450/.gemini/antigravity/scratch/discord-tts-bot/run.bat) or run in terminal:
```bash
node index.js
```

---

## 🎤 How to Use
1. Join any voice channel in your server.
2. In any text channel, type:
   * `/say text:Hello everyone!`
   * Or specify a language: `/say text:Bonjour tout le monde language:French`
3. The bot joins your voice channel, speaks the message, and leaves right after!
