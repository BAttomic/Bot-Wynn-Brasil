import { collections } from '../db/mongo.js';
import { fetchGuildMembers, isHigherRank, RANK_LABEL } from '../services/guildData.js';
import { getConfig } from '../config/guildConfig.js';
import { audit } from '../services/audit.js';
import { applyClassificationRoles, blacklistGuild, syncNickname } from '../services/registration.js';
import { loadBanIndex, recordBan, BAN_REASON_BLACKLIST_GUILD } from '../services/bans.js';
import { optional } from '../config/env.js';
import { log } from '../util/log.js';

/**
 * Sincroniza a classificação de cada vínculo (membro / neutro / banido), o
 * apelido e o cargo mais alto já alcançado.
 *
 * Os cargos de RANK (Líder, Sub-líder, …) NÃO são automáticos: são gestão manual
 * da staff. O rank só é gravado no banco, para /verificar e para o peakRank.
 *
 * Rodar isto de novo é o que pega quem entrou na guilda da black-list DEPOIS de
 * já ter se registrado.
 *
 * @param {import('discord.js').Client} client
 * @returns {Promise<void>}
 */
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
  const banIndex = await loadBanIndex();

  await guild.members.fetch().catch(() => {});

  const linked = await collections.members().find({}).toArray();
  for (const m of linked) {
    const rank = rankByUuid.get(m.uuid) || null;
    const inGuild = !!rank;

    // Entrou na guilda proibida desde o último ciclo? Entra na lista, para sempre.
    const nowInBlacklistGuild = blacklistedUuids.has(m.uuid);
    if (nowInBlacklistGuild && !banIndex.uuids.has(m.uuid)) {
      await recordBan({
        uuid: m.uuid,
        username: m.username,
        discordId: m.discordId,
        reason: BAN_REASON_BLACKLIST_GUILD,
      });
      banIndex.uuids.add(m.uuid);
      if (m.discordId) banIndex.discordIds.add(m.discordId);
    }

    // O banimento vence tudo, e não expira: sair da guilda proibida não devolve
    // o acesso. Só /ban remove desfaz.
    const banned = banIndex.uuids.has(m.uuid) || banIndex.discordIds.has(m.discordId);
    const kind = banned ? 'banned' : inGuild ? 'member' : 'neutral';

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
    // Passar a banido é registrado só no banco (campo `classification`).
    // Nenhum aviso no Discord — ver notifyRecruiters em services/registration.js.
    await collections.members().updateOne({ uuid: m.uuid }, { $set: update });

    const member = guild.members.cache.get(m.discordId);
    if (!member) continue;

    await applyClassificationRoles(member, cfg, kind);
    // Pega quem trocou de nick no Minecraft depois de registrado.
    await syncNickname(member, m.username);
  }
  log.info(`Role sync concluído (${linked.length} vínculos, ${res.members.length} membros na guilda, ${blacklistedUuids.size} na black-list).`);
}
