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

// Lightweight health-check web server (keeps 24/7 cloud hosts alive permanently)
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

// Helper for language choices
const languageChoices = [
  { name: 'English', value: 'en' },
  { name: 'Arabic', value: 'ar' },
  { name: 'French', value: 'fr' },
  { name: 'Spanish', value: 'es' },
  { name: 'German', value: 'de' },
  { name: 'Japanese', value: 'ja' },
];

// Define slash commands: /say, /tell, /tts
const commands = [
  new SlashCommandBuilder()
    .setName('say')
    .setDescription('Speaks your text in your voice channel and leaves')
    .addStringOption(option =>
      option
        .setName('text')
        .setDescription('The text you want the bot to say')
        .setRequired(true)
        .setMaxLength(250)
    )
    .addStringOption(option =>
      option
        .setName('language')
        .setDescription('Voice language (default: English)')
        .setRequired(false)
        .addChoices(...languageChoices)
    ),

  new SlashCommandBuilder()
    .setName('tell')
    .setDescription('Calls out someone by name in voice channel and delivers your message')
    .addUserOption(option =>
      option
        .setName('user')
        .setDescription('The person you want to talk to')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('text')
        .setDescription('What you want to tell them')
        .setRequired(true)
        .setMaxLength(250)
    )
    .addStringOption(option =>
      option
        .setName('language')
        .setDescription('Voice language (default: English)')
        .setRequired(false)
        .addChoices(...languageChoices)
    ),

  new SlashCommandBuilder()
    .setName('tts')
    .setDescription('Speaks your text in your voice channel and leaves')
    .addStringOption(option =>
      option
        .setName('text')
        .setDescription('The text you want the bot to say')
        .setRequired(true)
        .setMaxLength(250)
    )
    .addStringOption(option =>
      option
        .setName('language')
        .setDescription('Voice language (default: English)')
        .setRequired(false)
        .addChoices(...languageChoices)
    ),
].map(cmd => cmd.toJSON());

// Download audio helper
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

// Sleep helper
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
    
    // Clean, natural display name to call out
    const nameToCall = targetMember?.displayName || targetUser.globalName || targetUser.username;
    spokenText = `${nameToCall}, ${text}`;

    // Prefer joining target's voice channel; fallback to author's voice channel
    if (targetMember?.voice?.channel) {
      voiceChannel = targetMember.voice.channel;
    } else if (interaction.member?.voice?.channel) {
      voiceChannel = interaction.member.voice.channel;
    } else {
      return interaction.reply({
        content: `❌ Neither you nor **${nameToCall}** is currently in a voice channel!`,
        ephemeral: true,
      });
    }

    replyMessage = `📣 Calling **${nameToCall}** in <#${voiceChannel.id}>: "${text}"`;
  } else {
    // /say or /tts
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

  // Check bot permissions in voice channel
  const permissions = voiceChannel.permissionsFor(client.user);
  if (!permissions.has('Connect') || !permissions.has('Speak')) {
    return interaction.reply({
      content: '❌ I do not have permission to Connect and Speak in that voice channel!',
      ephemeral: true,
    });
  }

  await interaction.deferReply();

  const tempFilePath = path.join(
    __dirname,
    `temp_tts_${Date.now()}_${Math.random().toString(36).substring(7)}.mp3`
  );

  try {
    // 1. Generate TTS Audio URL
    const audioUrl = googleTTS.getAudioUrl(spokenText, {
      lang: lang,
      slow: false,
      host: 'https://translate.google.com',
    });

    // 2. Download audio file
    await downloadAudio(audioUrl, tempFilePath);

    // 3. Connect to target voice channel
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    });

    // Wait until connection is fully ready
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

    // Short 600ms pause so Discord's audio receiver connects smoothly before first word
    await sleep(600);

    // 4. Create and play audio resource
    const player = createAudioPlayer();
    const resource = createAudioResource(tempFilePath);

    player.play(resource);
    connection.subscribe(player);

    await interaction.editReply(replyMessage);

    // 5. Cleanup when audio finishes
    player.on(AudioPlayerStatus.Idle, () => {
      setTimeout(() => {
        if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
          connection.destroy();
        }
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
        }
      }, 500);
    });

    player.on('error', error => {
      console.error('Audio Player Error:', error);
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
        connection.destroy();
      }
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    });

    // Safety timeout (disconnect after 45s maximum)
    setTimeout(() => {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
        connection.destroy();
      }
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    }, 45_000);

  } catch (error) {
    console.error('TTS Error:', error);
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
    await interaction.editReply({
      content: `❌ Error speaking text: ${error.message}`,
    });
  }
});

client.login(process.env.DISCORD_TOKEN);
