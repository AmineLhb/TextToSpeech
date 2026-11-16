require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');
const googleTTS = require('google-tts-api');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// Global error handlers
process.on('unhandledRejection', error => {
  console.error('[Unhandled Rejection]:', error);
});
process.on('uncaughtException', error => {
  console.error('[Uncaught Exception]:', error);
});

// Health-check server
const port = process.env.PORT || 7860;
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Discord TTS Bot is Online 24/7!\n');
  })
  .listen(port, () => {
    console.log(`📡 Health-check server listening on port ${port}`);
  });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

client.on('error', error => {
  console.error('[Discord Client Error]:', error);
});

const languageChoices = [
  { name: 'English', value: 'en' },
  { name: 'Arabic', value: 'ar' },
  { name: 'French', value: 'fr' },
  { name: 'Spanish', value: 'es' },
  { name: 'German', value: 'de' },
  { name: 'Japanese', value: 'ja' },
];

const commands = [
  new SlashCommandBuilder()
    .setName('say')
    .setDescription('Speaks your text in your voice channel and leaves')
    .addStringOption(opt =>
      opt.setName('text').setDescription('The text to speak').setRequired(true).setMaxLength(250)
    )
    .addStringOption(opt =>
      opt.setName('language').setDescription('Voice language').setRequired(false).addChoices(...languageChoices)
    ),

  new SlashCommandBuilder()
    .setName('tell')
    .setDescription('Calls out someone by name in voice channel and delivers your message')
    .addUserOption(opt =>
      opt.setName('user').setDescription('The person to talk to').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('text').setDescription('What to tell them').setRequired(true).setMaxLength(250)
    )
    .addStringOption(opt =>
      opt.setName('language').setDescription('Voice language').setRequired(false).addChoices(...languageChoices)
    ),

  new SlashCommandBuilder()
    .setName('tts')
    .setDescription('Speaks your text in your voice channel and leaves')
    .addStringOption(opt =>
      opt.setName('text').setDescription('The text to speak').setRequired(true).setMaxLength(250)
    )
    .addStringOption(opt =>
      opt.setName('language').setDescription('Voice language').setRequired(false).addChoices(...languageChoices)
    ),
].map(cmd => cmd.toJSON());

function downloadAudio(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https
      .get(url, response => {
        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download audio: status ${response.statusCode}`));
          return;
        }
        response.pipe(file);
        file.on('finish', () => {
          file.close(resolve);
        });
      })
      .on('error', err => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Speech Queue: ensures rapid back-to-back /say or /tell commands never collide
let ttsQueue = Promise.resolve();

function queueTTS(channelId, text, lang) {
  const task = ttsQueue.then(() => playTTS(channelId, text, lang)).catch(err => {
    console.error('[Queue Error]:', err.message);
  });
  ttsQueue = task;
  return task;
}

// Battle-tested playTTS function
async function playTTS(channelId, text, lang) {
  const channel = await client.channels.fetch(channelId);
  const tempPath = path.join(__dirname, `temp_tts_${Date.now()}_${Math.random().toString(36).substring(7)}.mp3`);
  
  const audioUrl = googleTTS.getAudioUrl(text, {
    lang: lang || 'en',
    slow: false,
    host: 'https://translate.google.com',
  });
  await downloadAudio(audioUrl, tempPath);

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  await sleep(300);

  const player = createAudioPlayer();
  const resource = createAudioResource(tempPath);
  connection.subscribe(player);
  player.play(resource);

  return new Promise((resolve) => {
    player.on(AudioPlayerStatus.Idle, () => {
      setTimeout(() => {
        try { connection.destroy(); } catch (e) {}
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        resolve();
      }, 500);
    });

    player.on('error', err => {
      console.error('[Audio Player Error]:', err);
      try { connection.destroy(); } catch (e) {}
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      resolve();
    });
  });
}

client.once('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}!`);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log('🔄 Registering slash commands (/say, /tell, /tts)...');
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands,
    });
    console.log('✅ Slash commands registered successfully!');
  } catch (error) {
    console.error('Error registering slash commands:', error);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;
  if (commandName !== 'say' && commandName !== 'tell' && commandName !== 'tts') return;

  const text = interaction.options.getString('text');
  const lang = interaction.options.getString('language') || 'en';

  let targetChannelId = null;
  let spokenText = text;
  let replyMessage = '';

  if (commandName === 'tell') {
    const targetUser = interaction.options.getUser('user');
    const targetMember = interaction.options.getMember('user');
    const nameToCall = targetMember?.displayName || targetUser.globalName || targetUser.username;
    spokenText = `${nameToCall}, ${text}`;

    if (targetMember?.voice?.channelId) {
      targetChannelId = targetMember.voice.channelId;
    } else if (interaction.member?.voice?.channelId) {
      targetChannelId = interaction.member.voice.channelId;
    } else {
      return interaction.reply({
        content: `❌ Neither you nor **${nameToCall}** is in a voice channel!`,
        ephemeral: true,
      });
    }

    replyMessage = `📣 Calling **${nameToCall}** in <#${targetChannelId}>: "${text}"`;
  } else {
    if (!interaction.member?.voice?.channelId) {
      return interaction.reply({
        content: '❌ You must be in a voice channel to use this command!',
        ephemeral: true,
      });
    }

    targetChannelId = interaction.member.voice.channelId;
    spokenText = text;
    replyMessage = `🗣️ Speaking in <#${targetChannelId}>: "${text}"`;
  }

  try {
    await interaction.deferReply();
  } catch (e) {}

  try {
    console.log(`[TTS] Speaking "${spokenText}" in channel ${targetChannelId}...`);
    await queueTTS(targetChannelId, spokenText, lang);
    console.log(`[TTS] Finished speaking successfully.`);

    try {
      if (interaction.deferred) {
        await interaction.editReply(replyMessage);
      } else if (!interaction.replied) {
        await interaction.reply(replyMessage);
      }
    } catch (e) {}
  } catch (error) {
    console.error('[TTS Execution Error]:', error.message);
    try {
      if (interaction.deferred) {
        await interaction.editReply(`❌ Error speaking text: ${error.message}`);
      }
    } catch (e) {}
  }
});

client.login(process.env.DISCORD_TOKEN);
