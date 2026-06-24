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
import { PassThrough } from 'node:stream';
import { GoogleAuth } from 'google-auth-library';

// Ensure prism-media/@discordjs/voice can find ffmpeg
if (ffmpegPath) {
  process.env.FFMPEG_PATH = ffmpegPath;
}

// -------- Google Cloud TTS (REST v1beta1) --------
// Gemini-TTS (model_name + prompt) chỉ phục vụ qua endpoint v1beta1 và đi qua Vertex AI,
// nên BẮT BUỘC xác thực OAuth bằng service account (API key không có quyền IAM predict).
// Ưu tiên service account; fallback API key (chỉ dùng được cho giọng thường: WaveNet/Neural2/Chirp3).
const TTS_API_KEY = (process.env.GOOGLE_TTS_API_KEY || '').trim();
const TTS_ENDPOINT = 'https://texttospeech.googleapis.com/v1beta1/text:synthesize';

let googleAuth = null;
const _saInline = (process.env.GOOGLE_TTS_KEY_JSON || '').trim();
const _saFile = (process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
if (_saInline || _saFile) {
  const authOpts = { scopes: ['https://www.googleapis.com/auth/cloud-platform'] };
  if (_saInline) {
    try {
      authOpts.credentials = JSON.parse(_saInline);
    } catch (e) {
      console.error('GOOGLE_TTS_KEY_JSON không phải JSON hợp lệ:', e?.message || e);
      process.exit(1);
    }
  }
  // Nếu chỉ có GOOGLE_APPLICATION_CREDENTIALS, GoogleAuth tự đọc file theo đường dẫn đó.
  googleAuth = new GoogleAuth(authOpts);
}

if (!googleAuth && !TTS_API_KEY) {
  console.error('Thiếu xác thực: cần GOOGLE_TTS_KEY_JSON / GOOGLE_APPLICATION_CREDENTIALS (service account, cho Gemini-TTS) hoặc GOOGLE_TTS_API_KEY (giọng thường).');
  process.exit(1);
}

// Trả về header Authorization Bearer nếu dùng service account, ngược lại null (dùng ?key=).
async function getTtsAuthHeader() {
  if (!googleAuth) return null;
  const client = await googleAuth.getClient();
  const { token } = await client.getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : null;
}

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DEFAULT_TTS_RATE = Number.isFinite(Number(process.env.DEFAULT_TTS_RATE))
  ? Number(process.env.DEFAULT_TTS_RATE)
  : undefined;

// -------- TTS voice config --------
// Mặc định dùng giọng Standard (rẻ nhất: $4/1M ký tự, 4M ký tự miễn phí/tháng) qua API key.
// GEMINI_TTS_MODEL chỉ đặt khi dùng service account + Gemini-TTS; để trống = không gửi model_name.
const TTS_MODEL = typeof process.env.GEMINI_TTS_MODEL === 'string' && process.env.GEMINI_TTS_MODEL.trim().length > 0
  ? process.env.GEMINI_TTS_MODEL.trim()
  : '';
const DEFAULT_TTS_VOICE = typeof process.env.DEFAULT_TTS_VOICE === 'string' && process.env.DEFAULT_TTS_VOICE.trim().length > 0
  ? process.env.DEFAULT_TTS_VOICE.trim()
  : 'vi-VN-Standard-A';
const DEFAULT_TTS_STYLE = typeof process.env.DEFAULT_TTS_STYLE === 'string' && process.env.DEFAULT_TTS_STYLE.trim().length > 0
  ? process.env.DEFAULT_TTS_STYLE
  : 'Read aloud in a warm, welcoming tone.';
const SILENT_MODE = (process.env.SILENT_MODE || 'ack').toLowerCase(); // 'ack' | 'delete'
const CLEAR_DELAY_MS = Number.isFinite(Number(process.env.CLEAR_DELAY_MS))
  ? Number(process.env.CLEAR_DELAY_MS)
  : 3500;
const ACK_TEXT = typeof process.env.ACK_TEXT === 'string' ? process.env.ACK_TEXT : 'Đang xử lý...';

// Greeting config for join
const GREETING_TEXT = typeof process.env.GREETING_TEXT === 'string' && process.env.GREETING_TEXT.trim().length > 0
  ? process.env.GREETING_TEXT
  : 'Xin Chào Mọi Người ạ!';
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
const GREETING_STYLE = typeof process.env.GREETING_STYLE === 'string' && process.env.GREETING_STYLE.trim().length > 0
  ? process.env.GREETING_STYLE
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
const FAREWELL_STYLE = typeof process.env.FAREWELL_STYLE === 'string' && process.env.FAREWELL_STYLE.trim().length > 0
  ? process.env.FAREWELL_STYLE
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

// Add style (prompt) option for Gemini-TTS to control speaking style
ttsCommand.addStringOption((opt) =>
  opt
    .setName('style')
    .setDescription('Phong cách đọc cho Gemini-TTS, ví dụ: "đọc giọng vui vẻ, nhấn nhá"')
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
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
    });
    connection.on('stateChange', (o, n) => console.log(`[VOICE] connection ${o.status} -> ${n.status}`));
    connection.on('error', (e) => console.error('[VOICE] connection error:', e?.message || e));
    guildIdToConnection.set(guildId, connection);
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
      console.log('[VOICE] connection READY');
    } catch (e) {
      console.error('[VOICE] không vào được READY trong 15s:', e?.message || e);
      throw e;
    }
  }

  let player = guildIdToPlayer.get(guildId);
  if (!player) {
    player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    player.on('stateChange', (o, n) => console.log(`[VOICE] player ${o.status} -> ${n.status}`));
    player.on('error', (e) => console.error('[VOICE] player error:', e?.message || e));
    guildIdToPlayer.set(guildId, player);
  }
  connection.subscribe(player);

  return { connection, player };
}

const byteLen = (s) => Buffer.byteLength(s, 'utf8');

// maxBytes đo theo byte (UTF-8) vì giới hạn của API tính bằng byte, và tiếng Việt
// có nhiều ký tự nhiều byte. Gemini-TTS: text tối đa 4000 bytes -> dùng 3800 cho biên an toàn.
function splitTextToSegments(text, maxBytes = 3800) {
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
    const candidate = (current + ' ' + sentence).trim();
    if (byteLen(candidate) <= maxBytes) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      if (byteLen(sentence) <= maxBytes) {
        current = sentence;
      } else {
        // Cắt cứng câu quá dài theo byte mà không phá vỡ ký tự nhiều byte
        let buf = '';
        for (const ch of sentence) {
          if (byteLen(buf + ch) > maxBytes) {
            if (buf) chunks.push(buf);
            buf = ch;
          } else {
            buf += ch;
          }
        }
        current = buf;
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

async function synthesizeBuffers({ text, languageCode, voiceName, speakingRate, pitch, gender, modelName, prompt }) {
  const maxBytes = modelName ? 3800 : 4500;
  const segments = splitTextToSegments(text, maxBytes);
  const buffers = [];
  for (const segment of segments) {
    const voice = {
      languageCode: languageCode || 'vi-VN',
      name: voiceName || undefined,
    };
    if (modelName) {
      // Gemini-TTS: chọn model qua model_name (proto field 6), dùng voice theo tên (vd Leda)
      voice.modelName = modelName;
    } else if (!voiceName) {
      // Legacy (WaveNet/Standard): chọn giọng theo giới tính khi không có voice cụ thể
      voice.ssmlGender = mapGenderToSsml(gender);
    }
    const input = { text: segment };
    if (modelName && prompt) {
      // Style instruction — chỉ hỗ trợ với model promptable như Gemini-TTS
      input.prompt = prompt;
    }
    const audioConfig = { audioEncoding: 'MP3' };
    if (speakingRate != null) audioConfig.speakingRate = speakingRate;
    if (pitch != null) audioConfig.pitch = pitch;

    const headers = { 'Content-Type': 'application/json' };
    const authHeader = await getTtsAuthHeader();
    let url = TTS_ENDPOINT;
    if (authHeader) {
      Object.assign(headers, authHeader); // service account: OAuth Bearer
    } else {
      url += `?key=${encodeURIComponent(TTS_API_KEY)}`; // fallback: API key
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ input, voice, audioConfig }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`TTS API ${res.status}: ${errText}`);
    }
    const json = await res.json();
    if (!json.audioContent) {
      throw new Error('TTS API không trả về audioContent');
    }
    // REST trả audioContent dạng base64
    buffers.push(Buffer.from(json.audioContent, 'base64'));
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
  } catch (_) {
    // Bỏ qua mọi lỗi để không log gây nhiễu
    return { async clear() {} };
  }
  let cleared = false;
  return {
    async clear() {
      if (cleared) return;
      cleared = true;
      if (SILENT_MODE === 'delete') {
        // Chờ để client xử lý acknowledge, tránh hiển thị lỗi "This interaction failed"
        await new Promise((r) => setTimeout(r, CLEAR_DELAY_MS));
        await interaction.deleteReply().catch((e) => console.error('[ACK] deleteReply lỗi:', e?.message || e));
        console.log('[ACK] đã gọi deleteReply (mode=delete)');
      }
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
  const modelName = opts.model || TTS_MODEL; // mặc định Gemini-TTS cho tất cả
  const voiceName = opts.voice || DEFAULT_TTS_VOICE;
  const prompt = typeof opts.style === 'string' && opts.style.trim().length > 0
    ? opts.style.trim()
    : DEFAULT_TTS_STYLE;
  const gender = opts.gender || undefined;
  const audioBuffers = await synthesizeBuffers({
    text,
    languageCode: lang,
    voiceName,
    speakingRate,
    pitch,
    gender,
    modelName,
    prompt,
  });

  console.log(`[TTS] synth OK: ${audioBuffers.length} đoạn, voice=${voiceName}, model=${modelName || '(none)'}`);

  // Queue chunks sequentially
  for (const audioBuffer of audioBuffers) {
    const stream = new PassThrough();
    stream.end(audioBuffer);
    const { stream: probed, type } = await demuxProbe(stream);
    const resource = createAudioResource(probed, { inputType: type ?? StreamType.Arbitrary });
    player.play(resource);
    try {
      await entersState(player, AudioPlayerStatus.Playing, 5_000);
    } catch (e) {
      console.error('[VOICE] player không vào Playing trong 5s:', e?.message || e);
      throw e;
    }
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
            style: GREETING_STYLE,
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
        try {
          // Phát lời chào tạm biệt trước khi thoát
          const channelId = connection.joinConfig?.channelId;
          const vc = interaction.guild?.channels?.cache?.get(channelId);
          if (vc && typeof vc.joinable !== 'undefined') {
            const bye = buildFarewellText(interaction);
            await speakTextInChannel(vc, bye, FAREWELL_LANG, {
              rate: FAREWELL_RATE,
              pitch: FAREWELL_PITCH,
              voice: FAREWELL_VOICE,
              gender: FAREWELL_GENDER,
              style: FAREWELL_STYLE,
            });
          }
        } catch (e) {
          console.warn('farewell failed:', e?.message || e);
        }
        try { player?.stop(true); } catch {}
        try { connection.destroy(); } catch {}
        guildIdToConnection.delete(guildId);
        guildIdToPlayer.delete(guildId);
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
    const style = interaction.options.getString('style');
    await speakTextInChannel(voiceChannel, text, lang, { rate, pitch, voice, gender, style });
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


