import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, Events, SlashCommandBuilder, REST, Routes, PermissionsBitField, MessageFlags } from 'discord.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
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
const DEFAULT_TTS_RATE = Number.isFinite(Number(process.env.DEFAULT_TTS_RATE))
  ? Number(process.env.DEFAULT_TTS_RATE)
  : undefined;
const SILENT_MODE = (process.env.SILENT_MODE || 'ack').toLowerCase(); // 'ack' | 'delete'
const CLEAR_DELAY_MS = Number.isFinite(Number(process.env.CLEAR_DELAY_MS))
  ? Number(process.env.CLEAR_DELAY_MS)
  : 3500;
const ACK_TEXT = typeof process.env.ACK_TEXT === 'string' ? process.env.ACK_TEXT : 'Đang xử lý...';

// Greeting config for join
const GREETING_TEXT = typeof process.env.GREETING_TEXT === 'string' && process.env.GREETING_TEXT.trim().length > 0
  ? process.env.GREETING_TEXT
  : 'Xin Chào Sir Ani Agent Có mặt';
const GREETING_LANG = typeof process.env.GREETING_LANG === 'string' && process.env.GREETING_LANG.trim().length > 0
  ? process.env.GREETING_LANG
  : 'vi-VN';
const GREETING_RATE = Number.isFinite(Number(process.env.GREETING_RATE)) ? Number(process.env.GREETING_RATE) : undefined;
const GREETING_PITCH = Number.isFinite(Number(process.env.GREETING_PITCH)) ? Number(process.env.GREETING_PITCH) : undefined;
const GREETING_VOICE = typeof process.env.GREETING_VOICE === 'string' && process.env.GREETING_VOICE.trim().length > 0
  ? process.env.GREETING_VOICE
  : undefined;
const GREETING_GENDER = typeof process.env.GREETING_GENDER === 'string' && process.env.GREETING_GENDER.trim().length > 0
  ? process.env.GREETING_GENDER
  : undefined;

// Farewell config for leave
const FAREWELL_TEXT = typeof process.env.FAREWELL_TEXT === 'string' && process.env.FAREWELL_TEXT.trim().length > 0
  ? process.env.FAREWELL_TEXT
  : 'Tạm biệt {user}, hẹn gặp lại!';
const FAREWELL_LANG = typeof process.env.FAREWELL_LANG === 'string' && process.env.FAREWELL_LANG.trim().length > 0
  ? process.env.FAREWELL_LANG
  : 'vi-VN';
const FAREWELL_RATE = Number.isFinite(Number(process.env.FAREWELL_RATE)) ? Number(process.env.FAREWELL_RATE) : undefined;
const FAREWELL_PITCH = Number.isFinite(Number(process.env.FAREWELL_PITCH)) ? Number(process.env.FAREWELL_PITCH) : undefined;
const FAREWELL_VOICE = typeof process.env.FAREWELL_VOICE === 'string' && process.env.FAREWELL_VOICE.trim().length > 0
  ? process.env.FAREWELL_VOICE
  : undefined;
const FAREWELL_GENDER = typeof process.env.FAREWELL_GENDER === 'string' && process.env.FAREWELL_GENDER.trim().length > 0
  ? process.env.FAREWELL_GENDER
  : undefined;

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

// -------- Permissions (allowed roles) --------
const ALLOWED_ROLES_FILE = process.env.ALLOWED_ROLES_FILE || path.resolve(process.cwd(), 'configs/allowed_roles.json');

async function loadAllowedRoleIds() {
  try {
    const data = await fs.readFile(ALLOWED_ROLES_FILE, 'utf8');
    const json = JSON.parse(data);
    if (Array.isArray(json)) return json.map(String);
    if (Array.isArray(json.roleIds)) return json.roleIds.map(String);
    return [];
  } catch {
    return [];
  }
}

async function isMemberAllowed(member) {
  const allowed = await loadAllowedRoleIds();
  if (!allowed.length) return true; // No file or empty -> allow everyone
  const has = member?.roles?.cache?.some((role) => allowed.includes(role.id));
  return Boolean(has);
}

async function saveAllowedRoleIds(roleIds) {
  const dir = path.dirname(ALLOWED_ROLES_FILE);
  await fs.mkdir(dir, { recursive: true });
  const payload = { roleIds: Array.from(new Set(roleIds.map(String))) };
  await fs.writeFile(ALLOWED_ROLES_FILE, JSON.stringify(payload, null, 2), 'utf8');
}

function isManager(member) {
  const perms = member?.permissions;
  if (!perms) return false;
  return (
    perms.has(PermissionsBitField.Flags.ManageGuild) ||
    perms.has(PermissionsBitField.Flags.Administrator)
  );
}

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
  
// Add gender option for TTS selection when no specific voice is provided
ttsCommand.addStringOption((opt) =>
  opt
    .setName('gender')
    .setDescription('Giới tính giọng đọc (nếu không chọn voice cụ thể)')
    .addChoices(
      { name: 'Nam', value: 'male' },
      { name: 'Nữ', value: 'female' },
      { name: 'Trung tính', value: 'neutral' }
    )
    .setRequired(false)
);

const joinCommand = new SlashCommandBuilder()
  .setName('join')
  .setDescription('Bot tham gia voice channel của bạn');

const leaveCommand = new SlashCommandBuilder()
  .setName('leave')
  .setDescription('Bot rời voice channel');

const rolesCommand = new SlashCommandBuilder()
  .setName('tts-roles')
  .setDescription('Quản lý role được phép dùng TTS')
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Thêm role được phép')
      .addRoleOption((opt) =>
        opt
          .setName('role')
          .setDescription('Role cần thêm')
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Xóa role khỏi danh sách cho phép')
      .addRoleOption((opt) =>
        opt
          .setName('role')
          .setDescription('Role cần xóa')
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription('Xem danh sách role được phép')
  );

async function registerCommands(guildId) {
  const body = [ttsCommand.toJSON(), joinCommand.toJSON(), leaveCommand.toJSON(), rolesCommand.toJSON()];
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
    // Pre-check permissions/capacity before trying to connect
    const me = voiceChannel.guild.members?.me;
    const perms = voiceChannel.permissionsFor?.(me);
    const missing = [];
    if (!perms?.has(PermissionsBitField.Flags.ViewChannel)) missing.push('ViewChannel');
    if (!perms?.has(PermissionsBitField.Flags.Connect)) missing.push('Connect');
    if (!perms?.has(PermissionsBitField.Flags.Speak)) missing.push('Speak');
    const isFull = typeof voiceChannel.userLimit === 'number' && voiceChannel.userLimit > 0 && voiceChannel.members?.size >= voiceChannel.userLimit;
    if (missing.length) {
      throw new Error(`Bot thiếu quyền: ${missing.join(', ')} trong kênh thoại.`);
    }
    if (isFull) {
      throw new Error('Kênh thoại đã đầy, không thể tham gia.');
    }

    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    guildIdToConnection.set(guildId, connection);
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (e) {
      try { connection.destroy(); } catch {}
      guildIdToConnection.delete(guildId);
      throw new Error('Không thể kết nối tới voice channel (timeout). Vui lòng kiểm tra quyền Connect/Speak của bot, trạng thái server/kênh, và thử lại.');
    }
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

function mapGenderToSsml(gender) {
  if (!gender) return undefined;
  switch (gender) {
    case 'male':
      return 'MALE';
    case 'female':
      return 'FEMALE';
    case 'neutral':
      return 'NEUTRAL';
    default:
      return undefined;
  }
}

async function synthesizeBuffers({ text, languageCode, voiceName, speakingRate, pitch, gender }) {
  const segments = splitTextToSegments(text);
  const buffers = [];
  for (const segment of segments) {
    const [response] = await ttsClient.synthesizeSpeech({
      input: { text: segment },
      voice: {
        languageCode: languageCode || 'vi-VN',
        name: voiceName || undefined,
        ssmlGender: voiceName ? undefined : mapGenderToSsml(gender),
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

async function createResponder(interaction, initialContent) {
  try {
    await interaction.reply({ content: initialContent, flags: MessageFlags.Ephemeral });
    return {
      type: 'interaction',
      update: async (content) => {
        try {
          await interaction.editReply(content);
        } catch (e) {
          console.warn('editReply failed:', e?.message || e);
          await interaction.channel?.send(content).catch(() => {});
        }
      },
    };
  } catch (e) {
    console.warn('initial reply failed:', e?.message || e);
    const msg = await interaction.channel?.send(initialContent).catch(() => null);
    return {
      type: 'channel',
      update: async (content) => {
        try {
          if (msg && msg.edit) {
            await msg.edit(content);
          } else {
            await interaction.channel?.send(content).catch(() => {});
          }
        } catch (err) {
          console.warn('channel message update failed:', err?.message || err);
        }
      },
    };
  }
}

async function ackSilent(interaction, text = 'Đang xử lý...') {
  // Nếu đã được acknowledge, bỏ qua một cách im lặng
  if (interaction.deferred || interaction.replied) {
    return { async clear() {} };
  }
  try {
    const content = SILENT_MODE === 'ack' ? ACK_TEXT : text;
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    // Tự động xóa sau CLEAR_DELAY_MS nếu ở chế độ delete
    if (SILENT_MODE === 'delete') {
      setTimeout(() => {
        interaction.deleteReply().catch(() => {});
      }, CLEAR_DELAY_MS);
    }
  } catch (_) {
    // Bỏ qua mọi lỗi để không log gây nhiễu
    return { async clear() {} };
  }
  let cleared = false;
  return {
    async clear() {
      if (cleared) return;
      cleared = true;
      // Ở chế độ delete, việc xóa đã được hẹn giờ ở trên để tự động dismiss
    },
  };
}

function buildGreetingText(interaction) {
  const displayName = interaction?.member?.displayName || interaction?.user?.username || '';
  const serverName = interaction?.guild?.name || '';
  return (GREETING_TEXT || 'Xin chào!')
    .replace(/\{user\}/g, displayName)
    .replace(/\{server\}/g, serverName);
}

function buildFarewellText(interaction) {
  const displayName = interaction?.member?.displayName || interaction?.user?.username || '';
  const serverName = interaction?.guild?.name || '';
  return (FAREWELL_TEXT || 'Tạm biệt!')
    .replace(/\{user\}/g, displayName)
    .replace(/\{server\}/g, serverName);
}

async function speakTextInChannel(voiceChannel, text, lang = 'vi-VN', opts = {}) {
  const { player } = await ensureConnectionAndPlayer(voiceChannel);

  const speakingRate = typeof opts.rate === 'number'
    ? opts.rate
    : (DEFAULT_TTS_RATE ?? (opts.slow === 1 ? 0.85 : undefined));
  const pitch = typeof opts.pitch === 'number' ? opts.pitch : undefined;
  const voiceName = opts.voice || undefined;
  const gender = opts.gender || undefined;
  const audioBuffers = await synthesizeBuffers({
    text,
    languageCode: lang,
    voiceName,
    speakingRate,
    pitch,
    gender,
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
    if (process.env.REGISTER_COMMANDS_ON_STARTUP === 'true') {
      await registerCommands(process.env.GUILD_ID);
    }
  } catch (e) {
    console.error('Register commands failed:', e);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (!['tts', 'join', 'leave', 'tts-roles'].includes(interaction.commandName)) return;

    // Permission check theo role
    const allowed = await isMemberAllowed(interaction.member);
    if (!allowed) {
      await interaction.reply({ content: 'Bạn không có quyền dùng lệnh này.', flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }

    const voiceChannel = interaction.member?.voice?.channel;

    if (interaction.commandName === 'join') {
      const ack = await ackSilent(interaction, 'Đang vào kênh...');
      if (voiceChannel) {
        const displayName = interaction?.member?.displayName || interaction?.user?.username || interaction?.user?.id;
        console.log(
          `[JOIN_CMD] user="${displayName}" userId=${interaction.user?.id} guild="${interaction.guild?.name}" guildId=${interaction.guildId} channel="${voiceChannel.name}" time=${new Date().toISOString()}`
        );
        // If bot already connected elsewhere, cleanly leave first
        try {
          const existing = guildIdToConnection.get(interaction.guildId);
          if (existing && existing.joinConfig?.channelId && existing.joinConfig.channelId !== voiceChannel.id) {
            const player = guildIdToPlayer.get(interaction.guildId);
            try { player?.stop(true); } catch {}
            try { existing.destroy(); } catch {}
            guildIdToConnection.delete(interaction.guildId);
            guildIdToPlayer.delete(interaction.guildId);
          }
        } catch {}
        await ensureConnectionAndPlayer(voiceChannel);
        // Play greeting after join
        try {
          // Delay ~1s before greeting to ensure voice path is fully ready
          await new Promise((r) => setTimeout(r, 1000));
          const greet = buildGreetingText(interaction);
          await speakTextInChannel(voiceChannel, greet, GREETING_LANG, {
            rate: GREETING_RATE,
            pitch: GREETING_PITCH,
            voice: GREETING_VOICE,
            gender: GREETING_GENDER,
          });
        } catch (e) {
          console.warn('greeting failed:', e?.message || e);
        }
      }
      await ack.clear();
      return;
    }

    if (interaction.commandName === 'leave') {
      const ack = await ackSilent(interaction, 'Đang rời kênh...');
      const guildId = interaction.guildId;
      const connection = guildIdToConnection.get(guildId);
      const player = guildIdToPlayer.get(guildId);
      if (connection) {
        // Try to say farewell but do not block leaving indefinitely
        try {
          const channelId = connection.joinConfig?.channelId;
          let vc = interaction.guild?.channels?.cache?.get(channelId);
          if (!vc && interaction.guild?.channels?.fetch) {
            try { vc = await interaction.guild.channels.fetch(channelId); } catch {}
          }
          if (vc && typeof vc.joinable !== 'undefined') {
            const bye = buildFarewellText(interaction);
            const speakPromise = speakTextInChannel(vc, bye, FAREWELL_LANG, {
              rate: FAREWELL_RATE,
              pitch: FAREWELL_PITCH,
              voice: FAREWELL_VOICE,
              gender: FAREWELL_GENDER,
            });
            // Bound by timeout to avoid hanging if audio cannot be played
            const timeoutMs = 10_000;
            await Promise.race([
              speakPromise,
              new Promise((resolve) => setTimeout(resolve, timeoutMs)),
            ]);
          }
        } catch (e) {
          console.warn('farewell failed:', e?.message || e);
        } finally {
          try { player?.stop(true); } catch {}
          try { connection.destroy(); } catch {}
          guildIdToConnection.delete(guildId);
          guildIdToPlayer.delete(guildId);
        }
      }
      await ack.clear();
      return;
    }

    if (interaction.commandName === 'tts-roles') {
      const sub = interaction.options.getSubcommand();
      const current = await loadAllowedRoleIds();
      if (sub === 'list') {
        if (!current.length) {
          await interaction.reply({ content: 'Danh sách role được phép đang trống (mọi người đều được phép).', flags: MessageFlags.Ephemeral }).catch(() => {});
        } else {
          await interaction.reply({ content: 'Role được phép: ' + current.map((id) => `<@&${id}>`).join(', '), flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        return;
      }
      // Chỉ admin/Manage Server mới được add/remove
      if (!isManager(interaction.member)) {
        await interaction.reply({ content: 'Chỉ quản trị viên mới được thay đổi danh sách role.', flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }
      const role = interaction.options.getRole('role');
      if (!role) {
        await interaction.reply({ content: 'Không tìm thấy role.', flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }
      if (sub === 'add') {
        const next = Array.from(new Set([...current, role.id]));
        await saveAllowedRoleIds(next);
        await interaction.reply({ content: `Đã thêm role: <@&${role.id}>`, flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }
      if (sub === 'remove') {
        const next = current.filter((id) => id !== role.id);
        await saveAllowedRoleIds(next);
        await interaction.reply({ content: `Đã xóa role: <@&${role.id}>`, flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }
      return;
    }

    // tts: ack nhanh rồi xóa
    const ack = await ackSilent(interaction, 'Đang đọc...');
    if (!voiceChannel) { await ack.clear(); return; }
    const text = interaction.options.getString('text', true);
    const lang = interaction.options.getString('lang') || 'vi-VN';
    const rate = interaction.options.getNumber('rate');
    const pitch = interaction.options.getNumber('pitch');
    let voice = interaction.options.getString('voice');
    if (voice && !isManager(interaction.member)) {
      // Chỉ admin/quản lý mới được phép chọn voice cụ thể
      voice = null;
    }
    const gender = interaction.options.getString('gender');
    await speakTextInChannel(voiceChannel, text, lang, { rate, pitch, voice, gender });
    await ack.clear();
    return;
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


