import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, Events, SlashCommandBuilder, REST, Routes, MessageFlags } from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  NoSubscriberBehavior,
  createAudioResource,
  AudioPlayerStatus,
  entersState,
  VoiceConnectionStatus,
  demuxProbe,
  StreamType,
} from '@discordjs/voice';
import ffmpegPath from 'ffmpeg-static';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { PassThrough } from 'node:stream';

// Ensure prism-media/@discordjs/voice can find ffmpeg
if (ffmpegPath) {
  process.env.FFMPEG_PATH = ffmpegPath;
}

function createTtsClient() {
  const inlineKeyJson = process.env.GOOGLE_TTS_KEY_JSON;
  if (inlineKeyJson && inlineKeyJson.trim().length > 0) {
    try {
      const keyObj = JSON.parse(inlineKeyJson);
      const credentials = {
        client_email: keyObj.client_email,
        private_key: keyObj.private_key,
      };
      const projectId = keyObj.project_id;
      return new TextToSpeechClient({ credentials, projectId });
    } catch (e) {
      console.error('GOOGLE_TTS_KEY_JSON không hợp lệ. Sử dụng ADC mặc định nếu có.', e);
    }
  }
  // Fallback: GOOGLE_APPLICATION_CREDENTIALS (đường dẫn file) hoặc ADC khác
  return new TextToSpeechClient();
}

const ttsClient = createTtsClient();

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in .env');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const ttsCommand = new SlashCommandBuilder()
  .setName('tts')
  .setDescription('Bot đọc văn bản (Text To Speech) trong voice channel')
  .addStringOption((opt) =>
    opt
      .setName('text')
      .setDescription('Nội dung cần đọc')
      .setRequired(true)
  )
  .addStringOption((opt) =>
    opt
      .setName('lang')
      .setDescription('Mã ngôn ngữ (Google Cloud), ví dụ: vi-VN, en-US ...')
      .setRequired(false)
  )
  .addNumberOption((opt) =>
    opt
      .setName('rate')
      .setDescription('Tốc độ đọc (0.25 - 4.0). Mặc định theo hệ thống')
      .setRequired(false)
  )
  .addNumberOption((opt) =>
    opt
      .setName('pitch')
      .setDescription('Độ cao giọng (-20.0 đến 20.0)')
      .setRequired(false)
  )
  .addStringOption((opt) =>
    opt
      .setName('voice')
      .setDescription('Tên voice cụ thể, ví dụ: vi-VN-Wavenet-A')
      .setRequired(false)
  );

const joinCommand = new SlashCommandBuilder()
  .setName('join')
  .setDescription('Bot tham gia voice channel của bạn');

const leaveCommand = new SlashCommandBuilder()
  .setName('leave')
  .setDescription('Bot rời voice channel');

async function registerCommands(guildId) {
  const body = [ttsCommand.toJSON(), joinCommand.toJSON(), leaveCommand.toJSON()];
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body });
    console.log(`Registered guild commands for ${guildId}`);
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body });
    console.log('Registered global commands');
  }
}

// Connection/Player cache per guild
const guildIdToConnection = new Map();
const guildIdToPlayer = new Map();

async function ensureConnectionAndPlayer(voiceChannel) {
  const guildId = voiceChannel.guild.id;
  let connection = guildIdToConnection.get(guildId);
  if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
    });
    guildIdToConnection.set(guildId, connection);
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  }

  let player = guildIdToPlayer.get(guildId);
  if (!player) {
    player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    guildIdToPlayer.set(guildId, player);
  }
  connection.subscribe(player);

  return { connection, player };
}

function splitTextToSegments(text, maxLength = 4500) {
  const sentences = text
    .replace(/\s+/g, ' ')
    .split(/([\.!?\,\;\:])/)
    .reduce((acc, part, idx, arr) => {
      if (/[\.!?\,\;\:]/.test(part) && acc.length) {
        acc[acc.length - 1] += part;
      } else if (part.trim()) {
        acc.push(part.trim());
      }
      return acc;
    }, []);

  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    if ((current + ' ' + sentence).trim().length <= maxLength) {
      current = (current + ' ' + sentence).trim();
    } else {
      if (current) chunks.push(current);
      if (sentence.length <= maxLength) {
        current = sentence;
      } else {
        // Hard split very long sentence
        for (let i = 0; i < sentence.length; i += maxLength) {
          chunks.push(sentence.slice(i, i + maxLength));
        }
        current = '';
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function synthesizeBuffers({ text, languageCode, voiceName, speakingRate, pitch }) {
  const segments = splitTextToSegments(text);
  const buffers = [];
  for (const segment of segments) {
    const [response] = await ttsClient.synthesizeSpeech({
      input: { text: segment },
      voice: {
        languageCode: languageCode || 'vi-VN',
        name: voiceName || undefined,
      },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: speakingRate ?? undefined,
        pitch: pitch ?? undefined,
      },
    });
    const audioContent = response.audioContent;
    const buffer = Buffer.isBuffer(audioContent)
      ? audioContent
      : Buffer.from(audioContent);
    buffers.push(buffer);
  }
  return buffers;
}

async function speakTextInChannel(voiceChannel, text, lang = 'vi-VN', opts = {}) {
  const { player } = await ensureConnectionAndPlayer(voiceChannel);

  const speakingRate = typeof opts.rate === 'number' ? opts.rate : (opts.slow === 1 ? 0.85 : undefined);
  const pitch = typeof opts.pitch === 'number' ? opts.pitch : undefined;
  const voiceName = opts.voice || undefined;
  const audioBuffers = await synthesizeBuffers({
    text,
    languageCode: lang,
    voiceName,
    speakingRate,
    pitch,
  });

  // Queue chunks sequentially
  for (const audioBuffer of audioBuffers) {
    const stream = new PassThrough();
    stream.end(audioBuffer);
    const { stream: probed, type } = await demuxProbe(stream);
    const resource = createAudioResource(probed, { inputType: type ?? StreamType.Arbitrary });
    player.play(resource);
    await entersState(player, AudioPlayerStatus.Playing, 5_000);
    await new Promise((resolve) => player.once(AudioPlayerStatus.Idle, resolve));
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (e) {
    console.error('Register commands failed:', e);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (!['tts', 'join', 'leave'].includes(interaction.commandName)) return;

    // defer sớm để tránh hết hạn interaction ( >3s )
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Dùng cache để lấy voice channel, tránh gọi API chậm
    const voiceChannel = interaction.member?.voice?.channel;
    if (interaction.commandName === 'join') {
      if (!voiceChannel) {
        await interaction.editReply('Bạn cần vào một voice channel trước.');
        return;
      }
      await ensureConnectionAndPlayer(voiceChannel);
      await interaction.editReply(`Đã vào kênh thoại: ${voiceChannel.name}`);
      return;
    }

    if (interaction.commandName === 'leave') {
      const guildId = interaction.guildId;
      const connection = guildIdToConnection.get(guildId);
      const player = guildIdToPlayer.get(guildId);
      if (!connection) {
        await interaction.editReply('Bot chưa ở kênh thoại nào.');
        return;
      }
      try { player?.stop(true); } catch {}
      try { connection.destroy(); } catch {}
      guildIdToConnection.delete(guildId);
      guildIdToPlayer.delete(guildId);
      await interaction.editReply('Đã rời kênh thoại.');
      return;
    }

    // tts
    if (!voiceChannel) {
      await interaction.editReply('Bạn cần vào một voice channel trước.');
      return;
    }

    const text = interaction.options.getString('text', true);
    const lang = interaction.options.getString('lang') || 'vi-VN';
    const rate = interaction.options.getNumber('rate');
    const pitch = interaction.options.getNumber('pitch');
    const voice = interaction.options.getString('voice');

    await speakTextInChannel(voiceChannel, text, lang, { rate, pitch, voice });
    await interaction.editReply('Đã đọc xong.');
  } catch (error) {
    console.error(error);
    if (interaction.isRepliable()) {
      const content = 'Có lỗi xảy ra khi đọc TTS.';
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(content).catch(() => {});
      } else {
        await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  }
});

client.login(TOKEN);


