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
      .setDescription('Mã ngôn ngữ, ví dụ: vi, en, ja, ko ...')
      .setRequired(false)
  )
  .addNumberOption((opt) =>
    opt
      .setName('slow')
      .setDescription('Đọc chậm (1 là chậm, 0 là bình thường)')
      .setRequired(false)
  );

async function main() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const body = [ttsCommand.toJSON()];
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


