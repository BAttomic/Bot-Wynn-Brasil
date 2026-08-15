import { collections } from '../db/mongo.js';
import { fetchGuildMembers, isHigherRank, RANK_LABEL } from '../services/guildData.js';
import { getConfig } from '../config/guildConfig.js';
import { audit } from '../services/audit.js';
import { applyClassificationRoles, syncNickname } from '../services/registration.js';
import { loadGuildIndex } from '../services/guildList.js';
import { ensureAllyRole, syncAllyIdentity } from '../services/allyRoles.js';
import {
  loadBanIndex,
  recordBan,
  exemptInIndex,
  BAN_REASON_BLACKLIST_GUILD,
} from '../services/bans.js';
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

  // Uma requisição por guilda rastreada, não uma por membro. O cache de 60s da
  // API absorve a repetição entre ciclos vizinhos, e a lista é curta por
  // natureza — é uma decisão manual da staff, não um catálogo.
  const tracked = await loadGuildIndex();

  const blacklistedUuids = new Set();
  // uuid -> TAG da guilda proibida, para o apelido virar `[GsW] Fulano`.
  const blTagByPlayer = new Map();
  for (const doc of tracked.blacklist) {
    const roster = await fetchGuildMembers(doc.prefix).catch(() => null);
    if (!roster) {
      log.warn(`Roster da black-list [${doc.prefix}] indisponível neste ciclo.`);
      continue;
    }
    for (const m of roster.members) {
      blacklistedUuids.add(m.uuid);
      blTagByPlayer.set(m.uuid, roster.guild?.prefix ?? doc.prefix);
    }
  }

  // uuid do jogador -> { roleId, guildUuid } da guilda aliada dele.
  const allyByPlayer = new Map();
  for (let doc of tracked.ally) {
    const roster = await fetchGuildMembers(doc.prefix).catch(() => null);
    if (!roster) {
      log.warn(`Roster da aliada [${doc.prefix}] indisponível neste ciclo.`);
      continue;
    }
    // A guilda pode ter trocado de TAG ou de nome desde que entrou na lista; o
    // roster que acabamos de pagar já traz a versão atual, então o cargo é
    // renomeado junto, de graça.
    doc = await syncAllyIdentity(doc, roster.guild);
    const roleId = await ensureAllyRole(guild, cfg, doc);
    if (!roleId) continue;
    for (const m of roster.members) {
      allyByPlayer.set(m.uuid, { roleId, guildUuid: doc.uuid, tag: doc.prefix });
    }
  }

  const banIndex = await loadBanIndex();

  await guild.members.fetch().catch(() => {});

  const linked = await collections.members().find({}).toArray();
  for (const m of linked) {
    const rank = rankByUuid.get(m.uuid) || null;
    const inGuild = !!rank;

    // Entrou na guilda proibida desde o último ciclo? Entra na lista, para sempre.
    //
    // Salvo isenção: sem esta checagem, este job era justamente o que desfazia o
    // `/ban remove` — a pessoa saía da lista e, dez minutos depois, voltava por
    // continuar na GsW. A isenção é a decisão da staff, e ela vence a regra.
    const nowInBlacklistGuild = blacklistedUuids.has(m.uuid);
    const exempt = exemptInIndex(banIndex, { uuid: m.uuid, discordId: m.discordId });
    if (nowInBlacklistGuild && !exempt && !banIndex.uuids.has(m.uuid)) {
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
    // Ser nosso vem antes de ser aliado: quem aparece nas duas listas é nosso.
    const ally = !banned && !inGuild ? allyByPlayer.get(m.uuid) ?? null : null;
    const allyRoleId = ally?.roleId ?? null;
    const kind = banned ? 'banned' : inGuild ? 'member' : ally ? 'ally' : 'neutral';

    const update = {
      inGuild,
      guildRank: rank,
      classification: kind,
      allyGuildUuid: ally?.guildUuid ?? null,
    };

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

    await applyClassificationRoles(member, cfg, kind, allyRoleId);
    // Pega quem trocou de nick no Minecraft depois de registrado, e mantém a TAG
    // da guilda de fora na frente do apelido. A TAG vem da guilda REAL, não do
    // `kind`: quem está na guilda proibida carrega a TAG dela mesmo isento.
    const tag = blTagByPlayer.get(m.uuid) ?? ally?.tag ?? null;
    await syncNickname(member, m.username, tag);
  }
  log.info(
    `Role sync concluído (${linked.length} vínculos, ${res.members.length} membros na guilda, ` +
      `${blacklistedUuids.size} na black-list de ${tracked.blacklist.length} guilda(s), ` +
      `${allyByPlayer.size} aliado(s) de ${tracked.ally.length} guilda(s)).`,
  );
}
