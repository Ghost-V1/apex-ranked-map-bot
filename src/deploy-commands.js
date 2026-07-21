const { REST, Routes } = require('discord.js');
require('dotenv').config();

const commands = [
  {
    name: 'map',
    description: 'Show the current Apex Legends ranked BR map and next rotation',
  },
  {
    name: 'nextmap',
    description: 'Show what map is coming up next in ranked rotation',
  },
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('🔧 Registering slash commands...');
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('✅ Slash commands registered successfully!');
  } catch (err) {
    console.error('❌ Failed to register commands:', err.message);
  }
})();
