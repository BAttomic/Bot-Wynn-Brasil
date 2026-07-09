import { collections } from '../db/mongo.js';
import { fetchGuildMembers, isHigherRank, RANK_LABEL } from '../services/guildData.js';
import { getConfig } from '../config/guildConfig.js';
import { audit } from '../services/audit.js';
import { applyClassificationRoles, blacklistGuild } from '../services/registration.js';
import { optional } from '../config/env.js';
import { log } from '../util/log.js';

// Sincroniza a classificação (membro / neutro / banido) e o cargo automático
// "Top Contribuidor". Os cargos de RANK (Líder/Chefe/...) NÃO são automáticos —
// gestão manual (decisão do dono). O rank é apenas registrado no banco para
// /verificar, pontos, etc. Rodar isto de novo é o que pega quem entrou na guilda
// da black-list DEPOIS de já ter se registrado.
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

  const blacklisted = await fetchGuildMembers(blacklistGuild().prefix).catch(() => null);
  const blacklistedUuids = new Set(blacklisted?.members.map((m) => m.uuid) ?? []);

  await guild.members.fetch().catch(() => {});

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
    // A black-list vence: estar na guilda dela bane mesmo que também conste na nossa.
    const kind = blacklistedUuids.has(m.uuid) ? 'banned' : inGuild ? 'member' : 'neutral';

    const update = { inGuild, guildRank: rank, classification: kind };

    // Cargo mais alto que a pessoa já teve. Sobrevive a kick por inatividade,
    // então quando ela voltar dá para devolver o cargo que tinha.
    if (isHigherRank(rank, m.peakRank)) {
      update.peakRank = rank;
      update.peakRankAt = new Date();
    }

    if (inGuild && !m.inGuild) {
      update.joinedGuildAt = new Date();
      update.guildConfirmed = true;
      audit(client, guildDiscordId, `✅ <@${m.discordId}> (**${m.username}**) entrou na guilda como ${rank}.`);
      // Voltou abaixo do que já foi: avisa a staff, que promove no jogo.
      if (isHigherRank(m.peakRank, rank)) {
        audit(
          client,
          guildDiscordId,
          `⬆️ <@${m.discordId}> (**${m.username}**) já foi **${RANK_LABEL[m.peakRank] ?? m.peakRank}** e voltou como **${RANK_LABEL[rank] ?? rank}**. Considere restaurar o cargo.`,
        );
      }
    } else if (!inGuild && m.inGuild) {
      update.leftGuildAt = new Date();
      audit(client, guildDiscordId, `👋 <@${m.discordId}> (**${m.username}**) saiu da guilda.`);
    }
    if (kind === 'banned' && m.classification !== 'banned') {
      audit(client, guildDiscordId, `🚫 <@${m.discordId}> (**${m.username}**) entrou na [${blacklistGuild().prefix}] e recebeu o cargo de banido.`);
    }
    await collections.members().updateOne({ uuid: m.uuid }, { $set: update });

    const member = guild.members.cache.get(m.discordId);
    if (!member) continue;

    await applyClassificationRoles(member, cfg, kind);

    // Cargo "Top Contribuidor": top N em pontos que ainda estão na guilda.
    if (topRoleId) {
      const should = kind === 'member' && topUuids.has(m.uuid);
      const has = member.roles.cache.has(topRoleId);
      if (should && !has) await member.roles.add(topRoleId).catch(() => {});
      else if (!should && has) await member.roles.remove(topRoleId).catch(() => {});
    }
  }
  log.info(`Role sync concluído (${linked.length} vínculos, ${res.members.length} membros na guilda, ${blacklistedUuids.size} na black-list).`);
}
