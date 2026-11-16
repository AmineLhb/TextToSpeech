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

// Define /say and /tts commands
const commands = [
  new SlashCommandBuilder()
    .setName('say')
    .setDescription('Speaks your text in your voice channel and leaves')
    .addStringOption(option =>
      option
        .setName('text')
        .setDescription('The text you want the bot to say')
        .setRequired(true)
        .setMaxLength(200)
    )
    .addStringOption(option =>
      option
        .setName('language')
        .setDescription('Voice language (default: English)')
        .setRequired(false)
        .addChoices(
          { name: 'English', value: 'en' },
          { name: 'Arabic', value: 'ar' },
          { name: 'French', value: 'fr' },
          { name: 'Spanish', value: 'es' },
          { name: 'German', value: 'de' },
          { name: 'Japanese', value: 'ja' }
        )
    ),
  new SlashCommandBuilder()
    .setName('tts')
    .setDescription('Speaks your text in your voice channel and leaves')
    .addStringOption(option =>
      option
        .setName('text')
        .setDescription('The text you want the bot to say')
        .setRequired(true)
        .setMaxLength(200)
    )
    .addStringOption(option =>
      option
        .setName('language')
        .setDescription('Voice language (default: English)')
        .setRequired(false)
        .addChoices(
          { name: 'English', value: 'en' },
          { name: 'Arabic', value: 'ar' },
          { name: 'French', value: 'fr' },
          { name: 'Spanish', value: 'es' },
          { name: 'German', value: 'de' },
          { name: 'Japanese', value: 'ja' }
        )
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

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}!`);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log('🔄 Registering slash commands...');
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
  if (commandName !== 'say' && commandName !== 'tts') return;

  const text = interaction.options.getString('text');
  const lang = interaction.options.getString('language') || 'en';

  const memberVoiceChannel = interaction.member?.voice?.channel;
  if (!memberVoiceChannel) {
    return interaction.reply({
      content: '❌ You must be inside a voice channel to use this command!',
      ephemeral: true,
    });
  }

  // Check bot permissions in target voice channel
  const permissions = memberVoiceChannel.permissionsFor(client.user);
  if (!permissions.has('Connect') || !permissions.has('Speak')) {
    return interaction.reply({
      content: '❌ I do not have permission to join or speak in your voice channel!',
      ephemeral: true,
    });
  }

  await interaction.deferReply();

  const tempFilePath = path.join(__dirname, `temp_tts_${Date.now()}_${Math.random().toString(36).substring(7)}.mp3`);

  try {
    // 1. Get Google TTS URL
    const audioUrl = googleTTS.getAudioUrl(text, {
      lang: lang,
      slow: false,
      host: 'https://translate.google.com',
    });

    // 2. Download audio file
    await downloadAudio(audioUrl, tempFilePath);

    // 3. Connect to user's voice channel
    const connection = joinVoiceChannel({
      channelId: memberVoiceChannel.id,
      guildId: memberVoiceChannel.guild.id,
      adapterCreator: memberVoiceChannel.guild.voiceAdapterCreator,
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

    // 4. Create and play audio resource
    const player = createAudioPlayer();
    const resource = createAudioResource(tempFilePath);

    player.play(resource);
    connection.subscribe(player);

    await interaction.editReply(`🗣️ **Speaking:** "${text}" in <#${memberVoiceChannel.id}>`);

    // 5. When playback finishes, disconnect and clean up
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

    // Fallback safety timeout (disconnect after 45s if idle event fails)
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
