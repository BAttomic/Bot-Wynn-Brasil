import { collections } from '../db/mongo.js';
import {
  fetchGuildMembers,
  isHigherRank,
  rankRoleIds,
  RANK_LABEL,
  LEADERSHIP_RANKS,
} from '../services/guildData.js';
import { getConfig } from '../config/guildConfig.js';
import { audit } from '../services/audit.js';
import { applyClassificationRoles, syncNickname } from '../services/registration.js';
import { loadGuildIndex } from '../services/guildList.js';
import { ensureAllyRole, syncAllyIdentity } from '../services/allyRoles.js';
import { closeJoinedApplications } from '../services/applications.js';
import { sendGuildWelcome } from '../services/recruitWelcome.js';
import {
  loadBanIndex,
  recordBan,
  exemptInIndex,
  BAN_REASON_BLACKLIST_GUILD,
} from '../services/bans.js';
import { optional } from '../config/env.js';
import { log } from '../util/log.js';

/**
 * Cargo de OCIOSO: quem tem cargo de liderança no Discord (Capitão para cima) e
 * não está mais na guilda.
 *
 * O cargo de rank é manual — a staff dá e ninguém tira quando a pessoa sai. O
 * resultado é uma lista de liderança que não corresponde a ninguém: gente com
 * poder de Capitão no servidor e sem guilda há meses. Este cargo torna isso
 * visível sem mexer no que a staff aplicou à mão.
 *
 * É SIMÉTRICO de propósito. Sai sozinho quando a pessoa volta para a guilda, e
 * também quando a staff tira o cargo de rank dela — senão viraria uma marca
 * permanente que só some na mão, que é exatamente o problema que ele resolve.
 *
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').Guild} guild
 * @param {object} cfg
 * @param {Set<string>} naGuilda  discordIds confirmados no roster
 * @param {boolean} cacheCompleto  se a lista de membros do Discord veio inteira
 */
async function syncIdleRole(client, guild, cfg, naGuilda, cacheCompleto) {
  const idleId = cfg.roles?.idle;
  if (!idleId) return;
  // Cache incompleto = decisão incompleta. Com meia lista de membros, o laço
  // abaixo tiraria o cargo de quem simplesmente não foi carregado.
  if (!cacheCompleto) return;

  const rankIds = rankRoleIds(guild, LEADERSHIP_RANKS);
  if (!rankIds.size) {
    log.warn('Cargo de Ocioso configurado, mas nenhum cargo de liderança encontrado pelo nome.');
    return;
  }

  let deu = 0;
  let tirou = 0;
  for (const member of guild.members.cache.values()) {
    if (member.user.bot) continue;

    const temRank = [...rankIds].some((id) => member.roles.cache.has(id));
    const deveTer = temRank && !naGuilda.has(member.id);
    const tem = member.roles.cache.has(idleId);

    if (deveTer && !tem) {
      await member.roles.add(idleId).catch(() => {});
      deu += 1;
    } else if (!deveTer && tem) {
      await member.roles.remove(idleId).catch(() => {});
      tirou += 1;
    }
  }

  // Um aviso por ciclo, com os números: na primeira passada isto pode pegar
  // dezenas de pessoas, e uma linha por membro afogaria a auditoria.
  if (deu || tirou) {
    log.info(`Cargo de Ocioso: +${deu}, -${tirou}.`);
    await audit(
      client,
      guild.id,
      `💤 Cargo de Ocioso: **${deu}** aplicado(s), **${tirou}** removido(s) — liderança fora da guilda.`,
    );
  }
}

/**
 * Sincroniza a classificação de cada vínculo (membro / neutro / banido), o
 * apelido e o cargo mais alto já alcançado.
 *
 * Os cargos de RANK (Líder, Chefe, …) NÃO são automáticos: são gestão manual
 * da staff. O rank só é gravado no banco, para /verificar e para o peakRank —
 * e, desde o cargo de Ocioso, para marcar quem tem rank sem estar na guilda.
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

  // Quem está no roster cumpriu a fila de entrada: a candidatura fecha aqui.
  //
  // Vai o roster INTEIRO, e não só quem entrou neste ciclo, porque isso também
  // resolve quem já estava dentro antes do estado `joined` existir — sem
  // migração à parte. Depois da primeira passada não casa mais nada.
  const fechadas = await closeJoinedApplications(client, [...rankByUuid.keys()]);
  if (fechadas) log.info(`Fila de entrada: ${fechadas} candidatura(s) fechada(s) por já estarem na guilda.`);

  // Nick ATUAL de quem aparece em algum roster, na grafia da API. Alimentado por
  // todo roster que este ciclo baixar — sai de graça, já que eles vêm de
  // qualquer jeito. Sem isto, o job renomeava a pessoa para o `username` gravado
  // no vínculo, que nunca era atualizado: quem trocasse de nome no jogo ficava
  // com o apelido antigo restaurado a cada 10 minutos, para sempre.
  const nameByUuid = new Map(res.members.map((m) => [m.uuid, m.username]));

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
      nameByUuid.set(m.uuid, m.username);
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
      nameByUuid.set(m.uuid, m.username);
    }
  }

  const banIndex = await loadBanIndex();

  // Guardamos se o fetch FUNCIONOU. Sem ele o cache fica incompleto, e aí não
  // dá para concluir que alguém "não está no Discord" — todo mundo pareceria
  // fora, e a auditoria do ciclo inteiro sairia com o rótulo errado.
  const cacheCompleto = await guild.members.fetch().then(
    () => true,
    () => false,
  );
  if (!cacheCompleto) log.warn('Lista de membros do Discord indisponível neste ciclo; cargos e apelidos ficam para o próximo.');

  const linked = await collections.members().find({}).toArray();
  // Quem o roster confirma na guilda AGORA, por Discord. Alimenta o cargo de
  // Ocioso lá embaixo, e sai de graça deste laço que já roda de qualquer jeito.
  const naGuilda = new Set();
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

    // Trocou de nome no jogo? O roster é a fonte fresca; o vínculo é o que
    // estava guardado. O nome novo passa a valer para o banco E para o apelido.
    const nomeAtual = nameByUuid.get(m.uuid) ?? m.username;

    // `<@id>` de quem saiu do DISCORD o cliente renderiza como
    // "@usuário-desconhecido": um rótulo que não identifica ninguém e ocupa o
    // lugar do nick, que era a informação útil da linha. Quem não está mais no
    // servidor é citado pelo nick — e a auditoria passa a dizer isso, que é um
    // fato que a staff quer saber ao ver alguém saindo da guilda.
    const noServidor = !cacheCompleto || (!!m.discordId && guild.members.cache.has(m.discordId));
    const quem = noServidor
      ? `<@${m.discordId}> (**${nomeAtual}**)`
      : `**${nomeAtual}** (fora do Discord)`;

    const update = {
      inGuild,
      guildRank: rank,
      classification: kind,
      allyGuildUuid: ally?.guildUuid ?? null,
    };
    if (nomeAtual !== m.username) {
      update.username = nomeAtual;
      // Aqui o nick antigo e o novo já aparecem no texto, então repetir o atual
      // como sujeito seria redundante: fora do servidor, a frase começa no verbo.
      audit(
        client,
        guildDiscordId,
        `🪪 ${noServidor ? `<@${m.discordId}> ` : ''}trocou de nick no jogo: **${m.username}** → **${nomeAtual}**.`,
      );
    }

    // Cargo mais alto que a pessoa já teve. Sobrevive a kick por inatividade,
    // então quando ela voltar dá para devolver o cargo que tinha.
    if (isHigherRank(rank, m.peakRank)) {
      update.peakRank = rank;
      update.peakRankAt = new Date();
    }

    if (inGuild && !m.inGuild) {
      update.joinedGuildAt = new Date();
      update.guildConfirmed = true;
      audit(client, guildDiscordId, `✅ ${quem} entrou na guilda como ${rank}.`);
      // Só na TRANSIÇÃO. Se ficasse junto do fechamento em massa da fila, a
      // primeira passada depois do deploy mencionaria a guilda inteira de uma
      // vez — 80 pings de boas-vindas para gente que entrou meses atrás.
      await sendGuildWelcome(client, cfg, { discordId: m.discordId, username: m.username });
      // Voltou abaixo do que já foi: avisa a staff, que promove no jogo.
      if (isHigherRank(m.peakRank, rank)) {
        audit(
          client,
          guildDiscordId,
          `⬆️ ${quem} já foi **${RANK_LABEL[m.peakRank] ?? m.peakRank}** e voltou como **${RANK_LABEL[rank] ?? rank}**. Considere restaurar o cargo.`,
        );
      }
    } else if (!inGuild && m.inGuild) {
      update.leftGuildAt = new Date();
      audit(client, guildDiscordId, `👋 ${quem} saiu da guilda.`);
    }
    // Passar a banido é registrado só no banco (campo `classification`).
    // Nenhum aviso no Discord — ver notifyRecruiters em services/registration.js.
    await collections.members().updateOne({ uuid: m.uuid }, { $set: update });

    if (inGuild && m.discordId) naGuilda.add(m.discordId);

    const member = guild.members.cache.get(m.discordId);
    if (!member) continue;

    await applyClassificationRoles(member, cfg, kind, allyRoleId);
    // Pega quem trocou de nick no Minecraft depois de registrado, e mantém a TAG
    // da guilda de fora na frente do apelido. A TAG vem da guilda REAL, não do
    // `kind`: quem está na guilda proibida carrega a TAG dela mesmo isento.
    const tag = blTagByPlayer.get(m.uuid) ?? ally?.tag ?? null;
    await syncNickname(member, nomeAtual, tag);
  }
  await syncIdleRole(client, guild, cfg, naGuilda, cacheCompleto);

  log.info(
    `Role sync concluído (${linked.length} vínculos, ${res.members.length} membros na guilda, ` +
      `${blacklistedUuids.size} na black-list de ${tracked.blacklist.length} guilda(s), ` +
      `${allyByPlayer.size} aliado(s) de ${tracked.ally.length} guilda(s)).`,
  );
}
