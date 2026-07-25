// Remove os cargos de classificação de TODOS os membros do servidor e deixa o
// roleSync reaplicá-los só a quem é elegível (registrado no bot + na guilda).
//
//   node scripts/reset-roles.js --dry     # mostra o que faria, sem tocar
//   node scripts/reset-roles.js           # remove e reaplica
//
// Por que um script, e não o roleSync sozinho: o roleSync só percorre membros
// COM vínculo no banco. Quem recebeu o cargo de Membro manualmente, sem nunca se
// registrar, é invisível para ele — o cargo nunca sairia. Aqui varremos o
// servidor inteiro.
//
// Cargos afetados (chaves de config): guildMember e community — os cargos de
// ACESSO. O cargo `banned` NUNCA é tocado: removê-lo devolveria acesso a um
// banido. Passe --incluir-neutro-orfao para também limpar quem tem community
// sem estar registrado (útil, mas mais agressivo).

import { Client, GatewayIntentBits } from 'discord.js';
import { loadEnv, required, optional } from '../src/config/env.js';
import { connectMongo, closeMongo } from '../src/db/mongo.js';
import { getConfig } from '../src/config/guildConfig.js';
import { runRoleSync } from '../src/jobs/roleSync.js';

const DRY = process.argv.includes('--dry');

/** Chaves de cargo que este reset gerencia. `banned` fica de fora de propósito. */
const RESET_KEYS = ['guildMember', 'community'];

async function main() {
  loadEnv();
  const token = required('DISCORD_TOKEN');
  const guildId = required('DISCORD_GUILD_ID');
  if (!optional('WYNN_GUILD_PREFIX')) throw new Error('WYNN_GUILD_PREFIX ausente: o roleSync não saberia reaplicar.');

  await connectMongo();
  const cfg = await getConfig(guildId);
  const targetIds = RESET_KEYS.map((k) => cfg.roles?.[k]).filter(Boolean);
  if (!targetIds.length) {
    throw new Error('Nenhum dos cargos guildMember/community está configurado. Rode /config role primeiro.');
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
  await client.login(token);
  await new Promise((r) => client.once('clientReady', r));

  const guild = await client.guilds.fetch(guildId);
  const members = await guild.members.fetch(); // precisa do intent GuildMembers

  console.log(`Cargos a remover: ${RESET_KEYS.map((k) => `${k}=${cfg.roles[k] ?? '—'}`).join(', ')}`);
  console.log(`Membros no servidor: ${members.size}\n`);

  let afetados = 0;
  for (const member of members.values()) {
    const remover = targetIds.filter((id) => member.roles.cache.has(id));
    if (!remover.length) continue;
    afetados += 1;
    console.log(`${DRY ? '[dry] ' : ''}- ${member.user.tag}: tira ${remover.length} cargo(s)`);
    if (!DRY) {
      await member.roles.remove(remover, 'reset-roles: reconciliação de cargos').catch((e) => {
        console.error(`  falhou em ${member.user.tag}: ${e.message}`);
      });
    }
  }

  console.log(`\n${DRY ? '[dry] ' : ''}${afetados} membro(s) tinham cargo de acesso.`);

  if (DRY) {
    console.log('\n[dry] Nada foi alterado. Rode sem --dry para aplicar e reaplicar.');
  } else {
    console.log('\nReaplicando via roleSync (só quem é registrado + está na guilda)…');
    await runRoleSync(client);
    console.log('Pronto. Os cargos corretos foram devolvidos aos elegíveis.');
  }

  await client.destroy();
  await closeMongo();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
