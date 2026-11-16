require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionsBitField,
} = require('discord.js');
const {
  joinVoiceChannel,
  getVoiceConnection,
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

  const safeReply = async (content, ephemeral = false) => {
    try {
      if (interaction.deferred) {
        await interaction.editReply(content);
      } else if (!interaction.replied) {
        await interaction.reply(typeof content === 'string' ? { content, ephemeral } : content);
      }
    } catch (e) {}
  };

  const text = interaction.options.getString('text');
  const lang = interaction.options.getString('language') || 'en';

  let voiceChannel = null;
  let spokenText = text;
  let replyMessage = '';

  if (commandName === 'tell') {
    const targetUser = interaction.options.getUser('user');
    const targetMember = interaction.options.getMember('user');
    const nameToCall = targetMember?.displayName || targetUser.globalName || targetUser.username;
    spokenText = `${nameToCall}, ${text}`;

    if (targetMember?.voice?.channel) {
      voiceChannel = targetMember.voice.channel;
    } else if (interaction.member?.voice?.channel) {
      voiceChannel = interaction.member.voice.channel;
    } else {
      return safeReply(`❌ Neither you nor **${nameToCall}** is in a voice channel!`, true);
    }

    replyMessage = `📣 Calling **${nameToCall}** in <#${voiceChannel.id}>: "${text}"`;
  } else {
    voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      return safeReply('❌ You must be in a voice channel to use this command!', true);
    }

    spokenText = text;
    replyMessage = `🗣️ Speaking in <#${voiceChannel.id}>: "${text}"`;
  }

  // Acknowledge interaction quickly
  try {
    await interaction.deferReply();
  } catch (e) {}

  const tempFilePath = path.join(
    __dirname,
    `temp_tts_${Date.now()}_${Math.random().toString(36).substring(7)}.mp3`
  );

  let connection = null;

  try {
    console.log(`[TTS] Request: "${spokenText}" (${lang}) in channel ${voiceChannel.name}`);

    // 1. Download TTS Audio
    const audioUrl = googleTTS.getAudioUrl(spokenText, {
      lang: lang,
      slow: false,
      host: 'https://translate.google.com',
    });
    await downloadAudio(audioUrl, tempFilePath);

    // 2. Fetch full live channel & guild directly from client
    const targetChannelId = voiceChannel.id;
    const guild = client.guilds.cache.get(interaction.guildId) || (await client.guilds.fetch(interaction.guildId));
    const channel = await client.channels.fetch(targetChannelId);

    console.log(`[TTS] Connecting to voice channel ${channel.name} (${channel.id})...`);
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    connection.on('stateChange', (oldState, newState) => {
      console.log(`[VOICE STATE] ${oldState.status} -> ${newState.status}`);
    });
    connection.on('debug', msg => {
      console.log(`[VOICE DEBUG] ${msg}`);
    });
    connection.on('error', err => {
      console.error(`[VOICE ERROR]`, err);
    });

    // Wait up to 25 seconds for Ready state
    await entersState(connection, VoiceConnectionStatus.Ready, 25_000);
    console.log(`[TTS] Voice connection READY.`);

    // Buffer for Discord audio receiver
    await sleep(400);

    // 3. Play audio
    const player = createAudioPlayer();
    const resource = createAudioResource(tempFilePath);

    player.play(resource);
    connection.subscribe(player);
    console.log(`[TTS] Audio playing...`);

    await safeReply(replyMessage);

    // 4. Cleanup when finished
    player.on(AudioPlayerStatus.Idle, () => {
      console.log(`[TTS] Finished speaking, disconnecting.`);
      setTimeout(() => {
        try {
          connection.destroy();
        } catch (e) {}
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
        }
      }, 500);
    });

    player.on('error', error => {
      console.error('[TTS Player Error]:', error);
      try {
        connection.destroy();
      } catch (e) {}
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    });

    // Safety timeout (30s)
    setTimeout(() => {
      try {
        connection.destroy();
      } catch (e) {}
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    }, 30_000);

  } catch (error) {
    console.error('[TTS Catch Error]:', error.message);
    try {
      if (connection) connection.destroy();
    } catch (e) {}
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
    await safeReply(`❌ Error speaking text: ${error.message}`);
  }
});

client.login(process.env.DISCORD_TOKEN);
