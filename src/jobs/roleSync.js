import { collections } from '../db/mongo.js';
import { fetchGuildMembers } from '../services/guildData.js';
import { getConfig } from '../config/guildConfig.js';
import { audit } from '../services/audit.js';
import { optional } from '../config/env.js';
import { log } from '../util/log.js';

// Sincroniza a associação à guilda com o cargo único "Membro da Guilda" e o
// cargo automático "Top Contribuidor". Os cargos de RANK (Líder/Chefe/...) NÃO
// são automáticos — gestão manual (decisão do dono). O rank é apenas registrado
// no banco para /verificar, pontos, etc.
export async function runRoleSync(client) {
  const guildDiscordId = optional('DISCORD_GUILD_ID');
  const prefix = optional('WYNN_GUILD_PREFIX');
  if (!guildDiscordId || !prefix) return;

  const cfg = await getConfig(guildDiscordId);
  const guild = await client.guilds.fetch(guildDiscordId).catch(() => null);
  if (!guild) return;

  const res = await fetchGuildMembers(prefix);
  if (!res) return;
  const rankByUuid = new Map(res.members.map((m) => [m.uuid, m.rank]));

  await guild.members.fetch().catch(() => {});

  const memberRoleId = cfg.roles?.guildMember;
  const topRoleId = cfg.roles?.topContributor;
  const topCount = Number(cfg.params?.topContributorCount) || 3;

  // Top N por pontos (para o cargo de Top Contribuidor).
  let topUuids = new Set();
  if (topRoleId) {
    const top = await collections
      .guildStats()
      .find({ points: { $gt: 0 } })
      .sort({ points: -1 })
      .limit(topCount)
      .toArray();
    topUuids = new Set(top.map((t) => t.uuid));
  }

  const linked = await collections.members().find({}).toArray();
  for (const m of linked) {
    const rank = rankByUuid.get(m.uuid) || null;
    const inGuild = !!rank;

    const update = { inGuild, guildRank: rank };
    if (inGuild && !m.inGuild) {
      update.joinedGuildAt = new Date();
      update.guildConfirmed = true;
      audit(client, guildDiscordId, `✅ <@${m.discordId}> (**${m.username}**) entrou na guilda como ${rank}.`);
    } else if (!inGuild && m.inGuild) {
      update.leftGuildAt = new Date();
      audit(client, guildDiscordId, `👋 <@${m.discordId}> (**${m.username}**) saiu da guilda.`);
    }
    await collections.members().updateOne({ uuid: m.uuid }, { $set: update });

    const member = guild.members.cache.get(m.discordId);
    if (!member) continue;

    // Cargo "Membro da Guilda": presente sse está na guilda.
    if (memberRoleId) {
      const has = member.roles.cache.has(memberRoleId);
      if (inGuild && !has) await member.roles.add(memberRoleId).catch(() => {});
      else if (!inGuild && has) await member.roles.remove(memberRoleId).catch(() => {});
    }

    // Cargo "Top Contribuidor": top N em pontos que ainda estão na guilda.
    if (topRoleId) {
      const should = inGuild && topUuids.has(m.uuid);
      const has = member.roles.cache.has(topRoleId);
      if (should && !has) await member.roles.add(topRoleId).catch(() => {});
      else if (!should && has) await member.roles.remove(topRoleId).catch(() => {});
    }
  }
  log.info(`Role sync concluído (${linked.length} vínculos, ${res.members.length} membros na guilda).`);
}
