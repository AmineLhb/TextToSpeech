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

// Health-check web server
const port = process.env.PORT || 7860;
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Discord TTS Bot is Online 24/7!\n');
  })
  .listen(port, () => {
    console.log(`📡 Health-check server listening on port ${port}`);
  });

// Global process error handlers so the bot never crashes
process.on('unhandledRejection', error => {
  console.error('[Unhandled Rejection]:', error);
});
process.on('uncaughtException', error => {
  console.error('[Uncaught Exception]:', error);
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
      return interaction.reply({
        content: `❌ Neither you nor **${nameToCall}** is in a voice channel!`,
        ephemeral: true,
      });
    }

    replyMessage = `📣 Calling **${nameToCall}** in <#${voiceChannel.id}>: "${text}"`;
  } else {
    voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      return interaction.reply({
        content: '❌ You must be in a voice channel to use this command!',
        ephemeral: true,
      });
    }

    spokenText = text;
    replyMessage = `🗣️ Speaking in <#${voiceChannel.id}>: "${text}"`;
  }

  // Check bot permissions
  const botMember = interaction.guild.members.me;
  const permissions = voiceChannel.permissionsFor(botMember);
  if (!permissions.has(PermissionsBitField.Flags.Connect) || !permissions.has(PermissionsBitField.Flags.Speak)) {
    return interaction.reply({
      content: '❌ I do not have permission to Connect & Speak in that voice channel! Please give my role the "Connect" & "Speak" permission.',
      ephemeral: true,
    });
  }

  const tempFilePath = path.join(
    __dirname,
    `temp_tts_${Date.now()}_${Math.random().toString(36).substring(7)}.mp3`
  );

  let connection = null;

  try {
    try {
      await interaction.deferReply();
    } catch (e) {
      console.warn('Could not defer reply (interaction may have expired or been handled):', e.message);
    }
    console.log(`[TTS] Request: "${spokenText}" (${lang}) in channel ${voiceChannel.name} (${voiceChannel.id})`);

    // 1. Download TTS Audio
    const audioUrl = googleTTS.getAudioUrl(spokenText, {
      lang: lang,
      slow: false,
      host: 'https://translate.google.com',
    });
    await downloadAudio(audioUrl, tempFilePath);
    console.log(`[TTS] Audio downloaded successfully.`);

    // 2. Clean up any stale connection first
    const oldConnection = getVoiceConnection(interaction.guild.id);
    if (oldConnection) {
      try {
        oldConnection.destroy();
      } catch (e) {}
      await sleep(200);
    }

    // 3. Connect to voice
    console.log(`[TTS] Connecting to voice channel...`);
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: interaction.guild.id,
      adapterCreator: interaction.guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    connection.on('stateChange', (oldState, newState) => {
      console.log(`[VOICE STATE] ${oldState.status} -> ${newState.status}`);
    });

    // Wait up to 10 seconds for Ready state
    await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
    console.log(`[TTS] Voice connection READY.`);

    // Short buffer so Discord audio pipeline is fully active
    await sleep(400);

    // 4. Play audio
    const player = createAudioPlayer();
    const resource = createAudioResource(tempFilePath);

    player.play(resource);
    connection.subscribe(player);
    console.log(`[TTS] Audio playing...`);

    await interaction.editReply(replyMessage);

    // 5. Cleanup when idle
    player.on(AudioPlayerStatus.Idle, () => {
      console.log(`[TTS] Finished speaking, disconnecting.`);
      setTimeout(() => {
        try {
          if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
            connection.destroy();
          }
        } catch (e) {}
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
        }
      }, 400);
    });

    player.on('error', error => {
      console.error('[TTS Player Error]:', error);
      try {
        if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
          connection.destroy();
        }
      } catch (e) {}
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    });

    // Fallback safety timeout (30 seconds)
    setTimeout(() => {
      try {
        if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
          connection.destroy();
        }
      } catch (e) {}
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    }, 30_000);

  } catch (error) {
    console.error('[TTS Catch Error]:', error);
    try {
      if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
        connection.destroy();
      }
    } catch (e) {}
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }

    if (error.name === 'AbortError' || error.message.includes('aborted')) {
      await interaction.editReply({
        content: `❌ **Voice Connection Timed Out!**\nDiscord blocked the bot from joining the voice channel. Make sure the bot's role (**Sme3ni ngollik**) has the **Administrator** permission in Server Settings > Roles so it is allowed to enter the channel!`,
      });
    } else {
      await interaction.editReply({
        content: `❌ Error speaking text: ${error.message}`,
      });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
