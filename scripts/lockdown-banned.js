// Tranca o cargo de banido fora de todos os canais, exceto a black-list.
//
// Um cargo no Discord só SOMA permissão — ter o cargo de banido não remove o
// acesso que o @everyone já deu. A única coisa que subtrai é um override de
// negação no canal. E como override de canal vence override de categoria, basta
// negar "Ver Canal" em cada categoria (e nos canais soltos) e permitir na
// black-list.
//
//   node scripts/lockdown-banned.js          # aplica
//   node scripts/lockdown-banned.js --dry    # só mostra o que faria
//
// Canais criados DEPOIS disto herdam a permissão da categoria — se a categoria
// já estiver negada, o canal novo nasce trancado. Canais criados fora de
// qualquer categoria exigem rodar o script de novo.

import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { loadEnv, required } from '../src/config/env.js';
import { connectMongo, closeMongo } from '../src/db/mongo.js';
import { getConfig } from '../src/config/guildConfig.js';

const DRY = process.argv.includes('--dry');

async function main() {
  loadEnv();
  const token = required('DISCORD_TOKEN');
  const guildId = required('DISCORD_GUILD_ID');

  await connectMongo();
  const cfg = await getConfig(guildId);
  const bannedRoleId = cfg.roles?.banned;
  const blacklistId = cfg.channels?.blacklist;

  if (!bannedRoleId) throw new Error('Cargo de banido não configurado: /config role key:banned');
  if (!blacklistId) throw new Error('Canal da black-list não configurado: /config channel key:blacklist');

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(token);
  await new Promise((r) => client.once('clientReady', r));

  const guild = await client.guilds.fetch(guildId);
  const channels = await guild.channels.fetch();

  let denied = 0;
  for (const channel of channels.values()) {
    if (!channel || channel.id === blacklistId) continue;
    // Canais dentro de uma categoria herdam dela; basta trancar a categoria.
    const isCategory = channel.type === ChannelType.GuildCategory;
    if (!isCategory && channel.parentId) continue;

    console.log(`${DRY ? '[dry] ' : ''}negar Ver Canal em #${channel.name}`);
    if (!DRY) {
      await channel.permissionOverwrites.edit(bannedRoleId, { ViewChannel: false });
    }
    denied += 1;
  }

  // Override de canal vence override de categoria, então este allow funciona
  // mesmo que a black-list esteja dentro de uma categoria negada acima.
  const blacklist = await guild.channels.fetch(blacklistId);
  console.log(`${DRY ? '[dry] ' : ''}permitir acesso em #${blacklist.name}`);
  if (!DRY) {
    await blacklist.permissionOverwrites.edit(bannedRoleId, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: true,
    });
  }

  console.log(`\nPronto: ${denied} canais/categorias negados, black-list liberada.`);
  await client.destroy();
  await closeMongo();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
