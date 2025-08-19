import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID; // optional

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in .env');
  process.exit(1);
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
      .setDescription('Mã ngôn ngữ (ví dụ: vi-VN, en-US ...)')
      .setRequired(false)
  )
  .addNumberOption((opt) =>
    opt
      .setName('rate')
      .setDescription('Tốc độ đọc (0.25 - 4.0)')
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
      .setName('gender')
      .setDescription('Giới tính giọng đọc (nếu không chọn voice cụ thể)')
      .addChoices(
        { name: 'Nam', value: 'male' },
        { name: 'Nữ', value: 'female' },
        { name: 'Trung tính', value: 'neutral' },
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

async function main() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  // Preflight: ensure token belongs to the same application as CLIENT_ID
  try {
    const app = await rest.get(Routes.oauth2CurrentApplication());
    console.log('Detected application via token:', app.id, `(${app.name})`);
    if (String(app.id) !== String(CLIENT_ID)) {
      console.error(
        'DISCORD_CLIENT_ID không khớp với ứng dụng từ token.\n' +
        `- CLIENT_ID hiện tại: ${CLIENT_ID}\n` +
        `- Ứng dụng từ token: ${app.id} (${app.name})\n` +
        'Hãy cập nhật DISCORD_CLIENT_ID cho đúng Application ID của bot này, hoặc dùng token đúng của ứng dụng.'
      );
      process.exit(1);
    }
  } catch (e) {
    console.warn('Không lấy được thông tin ứng dụng từ token:', e?.message || e);
  }
  const body = [
    ttsCommand.toJSON(),
    joinCommand.toJSON(),
    leaveCommand.toJSON(),
    rolesCommand.toJSON(),
  ];
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body });
    console.log('Registered commands to guild', GUILD_ID);
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body });
    console.log('Registered global commands');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


