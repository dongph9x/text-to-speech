import 'dotenv/config';
import { REST, Routes } from 'discord.js';

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID; // optional

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in .env');
  process.exit(1);
}

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
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: [] });
    console.log('Cleared guild commands for', GUILD_ID);
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
    console.log('Cleared global commands');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


