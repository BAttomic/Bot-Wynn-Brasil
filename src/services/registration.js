import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { collections } from '../db/mongo.js';
import { wynn, isRateLimited } from '../wynn/api.js';
import { getConfig } from '../config/guildConfig.js';
import { optional } from '../config/env.js';
import { audit } from './audit.js';
import { isHigherRank } from './guildData.js';
import { findBan, findExemption, recordBan, BAN_REASON_BLACKLIST_GUILD } from './bans.js';
import { loadGuildIndex, allyRoleIds } from './guildList.js';
import { applyAllyRole, ensureAllyRole } from './allyRoles.js';
import { ensurePanel } from './panels.js';
import { logoAttachment, brandWithLogo } from '../util/assets.js';
import { log } from '../util/log.js';
import { pick } from '../util/i18n.js';

export const BUTTON_ID = 'registro:verificar';
export const MODAL_ID = 'registro:modal';
export const NICK_FIELD = 'nick';

const PANEL_STATE_ID = 'registrationPanel';

// Consultas à API por rodada do "registrar todos pelo apelido". A 0,6s cada
// (limite com chave), 150 dão ~1min30 — bem dentro dos 15 minutos que o token da
// interação dura, com folga para a resposta.
const MAX_LOOKUPS_PER_RUN = 150;

// Canais citados no painel de registro. Mention <#id> aponta para o canal e
// nunca pinga ninguém. IDs fixos, no mesmo espírito de staticPanels.js.
const RECRUIT_CHANNEL = '1309848293278486578';
const STATUS_CHANNEL = '1524920847637155861';

/**
 * O que PODE ser um nick do Minecraft: letras, números e `_`, até 20.
 *
 * Vive aqui porque é a regra do registro, e o registro é a única fonte de
 * identidade do bot. Serve para dois fins:
 *
 *  1. recusar o que nunca existiria (`Ninja no celular` tem espaços — não é
 *     nick, é apelido de Discord);
 *  2. evitar a consulta à API para algo que já sabemos que não é nick. Numa
 *     varredura de centenas de membros isso é a diferença entre caber no rate
 *     limit e não caber.
 *
 * @param {string} nick
 * @returns {boolean}
 */
export function isValidNick(nick) {
  return /^\w{1,20}$/.test(String(nick ?? '').trim());
}

// A nossa guilda ainda vem do ambiente: ela é uma só e não muda. As OUTRAS
// (black-list e aliadas) vivem no banco, geridas por `/guilds` — ver
// services/guildList.js.
function isOurGuild(g) {
  const ourUuid = optional('WYNN_GUILD_UUID');
  const ourPrefix = optional('WYNN_GUILD_PREFIX');
  return (!!ourUuid && g.uuid === ourUuid) || (!!ourPrefix && g.prefix === ourPrefix);
}

/**
 * 'member'  = está na nossa guilda
 * 'ally'    = está numa guilda aliada
 * 'banned'  = está numa guilda da black-list
 * 'neutral' = nenhuma delas (sem guilda ou em outra qualquer)
 *
 * A ordem importa: a black-list vence tudo, e a nossa guilda vem antes de
 * aliada — se alguém aparecer nas duas listas por engano, ser nosso ganha.
 *
 * Assíncrona porque a lista de guildas mora no banco; o índice é cacheado em
 * memória, então na prática isto não custa I/O.
 * @returns {Promise<'member'|'ally'|'neutral'|'banned'>}
 */
export async function classifyPlayer(player) {
  const g = player?.guild;
  if (!g) return 'neutral';
  const idx = await loadGuildIndex();
  // UUID é imutável; o prefixo pode ser trocado pelo dono, então serve só de
  // reforço. Qualquer um dos dois batendo já classifica.
  if (idx.blacklistUuids.has(g.uuid) || idx.blacklistPrefixes.has(g.prefix)) return 'banned';
  if (isOurGuild(g)) return 'member';
  if (idx.allyByUuid.has(g.uuid) || idx.allyByPrefix.has(g.prefix)) return 'ally';
  return 'neutral';
}

/** A guilda aliada de um jogador, ou null. */
export async function allyGuildOf(player) {
  const g = player?.guild;
  if (!g) return null;
  const idx = await loadGuildIndex();
  return idx.allyByUuid.get(g.uuid) ?? idx.allyByPrefix.get(g.prefix) ?? null;
}

/**
 * A TAG que vai na frente do apelido: a da guilda RASTREADA da pessoa, aliada ou
 * da black-list. `null` para membro nosso e para quem está em guilda que não
 * acompanhamos — esses ficam com o nick puro.
 */
export async function nickTagOf(player) {
  const g = player?.guild;
  if (!g) return null;
  const idx = await loadGuildIndex();
  if (isOurGuild(g)) return null;
  const aliada = idx.allyByUuid.get(g.uuid) ?? idx.allyByPrefix.get(g.prefix);
  if (aliada) return aliada.prefix;
  const proibida = idx.blacklist.find((b) => b.uuid === g.uuid || b.prefix === g.prefix);
  return proibida?.prefix ?? null;
}

// Cargos que cada classificação DEVE ter. O membro da guilda também é da
// comunidade — a recíproca não vale: o neutro tem só o de comunidade.
//
// O aliado é um neutro com identificação: mesmo acesso, mais o cargo `[TAG]
// Nome` da guilda dele, que é aplicado à parte (ver applyAllyRole).
const ROLES_BY_KIND = {
  member: ['guildMember', 'community'],
  ally: ['community'],
  neutral: ['community'],
  banned: [],
  // Sem registro não é uma classificação: é a AUSÊNCIA de uma. O cargo de
  // comunidade atesta "esta pessoa provou que é dona de uma conta do
  // WynnCraft", e quem nunca se registrou não provou nada. Só existe pelo
  // /reconciliar, que enxerga o servidor inteiro e não só quem tem vínculo.
  unregistered: [],
};

const ALL_CLASSIFICATION_KEYS = ['guildMember', 'community', 'banned'];

const KIND_LABEL = {
  member: 'Membro da Wynn Brasil',
  ally: 'Aliado',
  neutral: 'Neutro',
};

// Garante que o membro tenha EXATAMENTE um dos três cargos de classificação.
// Um banido também perde o cargo de comunidade: o acesso dele é só a black-list.
//
// Os cargos de RANK (Capitão, Estrategista, Sub-líder, Líder) NUNCA entram aqui.
// Eles saem do nick que a pessoa digitou, que ninguém verificou — dar Capitão a
// quem só escreveu o nick de um Capitão seria entregar a guilda. Rank é sempre
// aplicado à mão pela staff; o bot no máximo avisa (ver peakRank em roleSync).
// O 4º argumento é o cargo `[TAG] Nome` da guilda aliada. Ele é opcional de
// propósito: quem não passa nada (ban.js, warn.js) está dizendo "esta pessoa não
// é aliada", e o cargo de aliada que ela porventura tivesse é retirado.
export async function applyClassificationRoles(member, cfg, kind, allyRoleId = null) {
  const wantedKeys = ROLES_BY_KIND[kind] ?? [];
  const wantedIds = wantedKeys.map((k) => cfg.roles?.[k]).filter(Boolean);

  // O banido fica sem nenhum dos três: o cargo de banido é aplicado à parte
  // (abaixo) e o acesso dele vem só do override de canal na black-list.
  const bannedId = cfg.roles?.banned;
  const removeIds = ALL_CLASSIFICATION_KEYS.map((k) => cfg.roles?.[k])
    .filter(Boolean)
    .filter((id) => !wantedIds.includes(id) && !(kind === 'banned' && id === bannedId));

  for (const id of removeIds) {
    if (member.roles.cache.has(id)) await member.roles.remove(id).catch(() => {});
  }
  if (kind === 'banned' && bannedId && !member.roles.cache.has(bannedId)) {
    await member.roles.add(bannedId).catch(() => {});
  }
  for (const id of wantedIds) {
    if (!member.roles.cache.has(id)) await member.roles.add(id).catch(() => {});
  }

  // Exatamente um cargo de aliada, ou nenhum. Sempre: é isto que tira o `[TAG]`
  // de quem saiu da guilda aliada, entrou na nossa, ou foi banido.
  await applyAllyRole(member, await allyRoleIds(), kind === 'ally' ? allyRoleId : null);

  if (kind === 'banned') return bannedId;
  if (kind === 'ally' && allyRoleId) return allyRoleId;
  return wantedIds[0] ?? null;
}

/** Limite do Discord para apelido de membro. */
const NICK_MAX = 32;

/**
 * O apelido que a pessoa DEVE ter no Discord.
 *
 * Quem é de fora — guilda aliada ou da black-list — carrega a TAG na frente:
 * `[GsW] Fulano`. Isso torna a guilda de origem legível na lista de membros e em
 * qualquer menção, sem depender de ninguém abrir o perfil. Membro nosso e neutro
 * ficam com o nick puro: aqui é a Wynn Brasil, marcar todo mundo com [WnBR] só
 * geraria ruído.
 *
 * Existe como função única porque três lugares precisam concordar sobre isso —
 * o registro, o roleSync e o /reconciliar. Se cada um montasse a string, o
 * painel de reconciliação passaria a vida "corrigindo" o que o job acabou de
 * escrever.
 *
 * @param {string} username  nick do WynnCraft, na grafia da API
 * @param {string|null} [tag]  prefixo da guilda, se a pessoa for de fora
 * @returns {string}
 */
/**
 * `[GsW] Fulano` -> `Fulano`.
 *
 * Indispensável desde que o apelido passou a carregar a TAG: a identificação de
 * quem NÃO tem vínculo é feita casando o apelido contra os rosters, e
 * `[gsw] fulano` não casa com `fulano`. Sem descascar, o próprio bot marcaria
 * como "sem registro" alguém que ele mesmo acabou de renomear.
 */
export function stripNickTag(nick) {
  return String(nick ?? '')
    .replace(/^\[[^\]]{1,8}\]\s*/, '')
    .trim();
}

export function expectedNickname(username, tag = null) {
  if (!tag) return username;
  const comTag = `[${tag}] ${username}`;
  // Nick do Wynncraft vai a 20 e TAG a 4, então isto não deveria disparar; se
  // um dia disparar, o nick puro é melhor que um apelido truncado no meio.
  return comTag.length <= NICK_MAX ? comTag : username.slice(0, NICK_MAX);
}

// Deixa o apelido no Discord igual ao esperado (nick, com a TAG na frente se a
// pessoa for de guilda aliada ou da black-list).
//
// Falha silenciosamente em dois casos que o Discord não deixa contornar: o dono
// do servidor nunca pode ser renomeado por um bot, e nem quem tem cargo acima do
// cargo do bot. Não é erro do registro, então não atrapalha o resto.
export async function syncNickname(member, username, tag = null) {
  if (!member?.manageable) return false;
  const alvo = expectedNickname(username, tag);
  if (member.nickname === alvo) return true;
  const ok = await member.setNickname(alvo).then(() => true).catch(() => false);
  if (!ok) log.warn(`Não consegui renomear ${member.user?.tag ?? member.id} para "${alvo}".`);
  return ok;
}

// Só o registro de um NEUTRO (ou aliado) vira aviso: é um recruta em potencial.
//
// Vai para `recruitAlerts`, um canal de staff — e não para o de recrutamento,
// que é público e onde o próprio candidato está lendo o painel. Sem esse canal
// configurado, cai no log de auditoria.
//
// Um banido não gera mensagem nenhuma, em canal nenhum. Basta um print vazar
// para a regra da black-list virar pública, e aí quem é da guilda proibida passa
// a saber que precisa sair dela antes de se registrar.
// O aliado entra aqui junto com o neutro: antes desta lista existir ele ERA um
// neutro, e sumir do aviso seria perder informação que a staff já tinha.
async function notifyRecruitAlert(client, cfg, { player, kind, discordId }) {
  if (kind !== 'neutral' && kind !== 'ally') return;
  const channelId = cfg.channels?.recruitAlerts ?? cfg.channels?.logs;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  const guildLine = player.guild
    ? `[${player.guild.prefix}] ${player.guild.name} — ${player.guild.rank}`
    : 'Sem guilda';

  await channel
    .send({
      embeds: [
        {
          title: kind === 'ally' ? '🤝 Aliado registrado' : '🆕 Possível novo membro',
          color: kind === 'ally' ? 0x1abc9c : 0x95a5a6,
          description:
`**Discord:** <@${discordId}>
**Nick:** \`${player.username}\`
**Guilda atual:** \`${guildLine}\`
**Guerras (conta inteira):** \`${player.globalData?.wars ?? 0}\`
**Nível total:** \`${player.globalData?.totalLevel ?? 0}\``,
          thumbnail: { url: `https://visage.surgeplay.com/bust/350/${player.username}` },
          timestamp: new Date().toISOString(),
        },
      ],
      allowedMentions: { parse: [] },
    })
    .catch(() => {});
}

/**
 * Núcleo do vínculo, agnóstico de quem disparou. Escreve o vínculo, aplica
 * classificação/cargo/apelido e devolve o resultado — sem texto de UI.
 *
 * @param {object} args
 * @param {import('discord.js').Client}       args.client
 * @param {string}                            args.guildId
 * @param {string}                            args.targetDiscordId  dono do vínculo
 * @param {import('discord.js').GuildMember?} args.targetMember     para aplicar cargo/apelido
 * @param {string}                            args.rawNick
 * @param {string?}                           [args.actorId]  quem forçou (staff), se houver
 * @param {boolean}                           [args.force]    sobrescreve vínculos conflitantes
 * @returns {Promise<{ok: boolean, error?: string, kind?: string, roleId?: string|null, player?: object, replaced?: object|null}>}
 */
async function performLink({ client, guildId, targetDiscordId, targetMember, rawNick, actorId, force = false, silent = false }) {
  const nick = rawNick.trim();
  if (!isValidNick(nick)) {
    return {
      ok: false,
      code: 'invalid_nick',
      error: 'Nick inválido. Use apenas letras, números e `_` (até 20 caracteres).',
      errorEn: 'Invalid username. Use letters, numbers and `_` only (up to 20 characters).',
    };
  }

  // Rate limit NÃO é "não existe". Sem esta distinção, uma janela de 429 fazia o
  // registro dizer a gente de verdade que o nick dela não existe — e a pessoa
  // ficava tentando escrever de outro jeito um nick que estava certo.
  let player = null;
  let apiDown = false;
  try {
    player = await wynn.player(nick);
  } catch (e) {
    apiDown = isRateLimited(e);
    if (!apiDown) throw e;
  }
  if (apiDown) {
    return {
      ok: false,
      code: 'api_unavailable',
      error: 'A API do WynnCraft está limitando as consultas agora. Tente de novo em um minuto — não é problema com o seu nick.',
      errorEn: 'The WynnCraft API is rate limiting right now. Try again in a minute — nothing is wrong with your username.',
    };
  }
  if (!player || !player.uuid) {
    return {
      ok: false,
      code: 'not_found',
      error: `Não encontrei o jogador **${nick}** na API do WynnCraft. Confira a escrita do nick.`,
      errorEn: `I couldn't find the player **${nick}** in the WynnCraft API. Check the spelling.`,
    };
  }

  const members = collections.members();
  const byUuid = await members.findOne({ uuid: player.uuid });
  const byDiscord = await members.findOne({ discordId: targetDiscordId });

  // Conflitos: no fluxo normal são erro; no forçado, a staff assume e sobrescreve.
  if (byUuid && byUuid.discordId !== targetDiscordId && !force) {
    return {
      ok: false,
      code: 'conflict',
      error: 'Essa conta do WynnCraft já está vinculada a outro usuário. Fale com a staff se for engano.',
      errorEn: 'This WynnCraft account is already linked to someone else. Talk to the staff if this is a mistake.',
    };
  }
  if (byDiscord && byDiscord.uuid !== player.uuid && !force) {
    return {
      ok: false,
      code: 'conflict',
      error: `Seu Discord já está vinculado a **${byDiscord.username}**. Peça à staff um \`/unlink\` para trocar.`,
      errorEn: `Your Discord is already linked to **${byDiscord.username}**. Ask the staff for an \`/unlink\` to switch.`,
    };
  }

  // Ao forçar sobre conflitos, apaga os vínculos antigos para não colidir com os
  // índices únicos (uuid, discordId) na hora do upsert.
  const replaced = [];
  if (force) {
    if (byUuid && byUuid.discordId !== targetDiscordId) replaced.push(byUuid);
    if (byDiscord && byDiscord.uuid !== player.uuid) replaced.push(byDiscord);
    for (const doc of replaced) await members.deleteOne({ _id: doc._id });
  }

  // A lista de banidos vem antes da guilda: quem já foi banido continua banido,
  // mesmo que hoje esteja sem guilda ou dentro da nossa. E cada tentativa reforça
  // o par (uuid, discord), então trocar de conta ou de Discord só amplia a teia.
  const priorBan = await findBan({ uuid: player.uuid, discordId: targetDiscordId });
  // Isenção da staff vem antes de tudo: sem isto, bastava a pessoa se registrar
  // de novo para `classifyPlayer` reconhecer a guilda proibida e recriar o
  // banimento. Continuar nela isento não vira 'member' — vira 'neutral', o mesmo
  // que qualquer um de fora, e é o `inGuild` que decide se sobe para membro.
  const exemption = await findExemption({ uuid: player.uuid, discordId: targetDiscordId });
  let kind = await classifyPlayer(player);
  if (exemption) {
    if (kind === 'banned') kind = 'neutral';
  } else if (priorBan || kind === 'banned') {
    kind = 'banned';
    await recordBan({
      uuid: player.uuid,
      username: player.username,
      discordId: targetDiscordId,
      reason: priorBan?.reason ?? BAN_REASON_BLACKLIST_GUILD,
    });
  }

  const now = new Date();
  // O endpoint de player devolve o rank em MAIÚSCULAS ("OWNER"); o de guilda usa
  // minúsculas. Normalizamos aqui para o resto do bot comparar sem surpresa.
  const rank = player.guild?.rank ? player.guild.rank.toLowerCase() : null;

  // Só interessa a guilda aliada de quem REALMENTE é aliado: um banido ou um
  // membro nosso não carrega `[TAG]` de ninguém.
  const allyGuild = kind === 'ally' ? await allyGuildOf(player) : null;

  const set = {
    uuid: player.uuid,
    discordId: targetDiscordId,
    username: player.username,
    inGuild: kind === 'member',
    guildRank: rank,
    classification: kind,
    allyGuildUuid: allyGuild?.uuid ?? null,
  };
  if (kind === 'member' && isHigherRank(rank, byUuid?.peakRank)) {
    set.peakRank = rank;
    set.peakRankAt = now;
  }

  await members.updateOne(
    { uuid: player.uuid },
    { $set: set, $setOnInsert: { linkedAt: now, communitySince: now, guildWars: 0 } },
    { upsert: true },
  );

  const cfg = await getConfig(guildId);
  let roleId = null;
  if (targetMember?.roles?.add) {
    // O cargo da aliada é criado sob demanda: a guilda pode ter entrado na lista
    // sem ninguém dela no servidor ainda.
    const allyRoleId = allyGuild
      ? await ensureAllyRole(targetMember.guild, cfg, allyGuild).catch(() => null)
      : null;
    roleId = await applyClassificationRoles(targetMember, cfg, kind, allyRoleId);
    // A TAG sai da guilda REAL do jogador, não do `kind`: um banido isento
    // continua na guilda proibida e continua sendo identificado por ela.
    await syncNickname(targetMember, player.username, await nickTagOf(player));
  }

  // Em registro em massa (silent) não geramos aviso de recruta nem uma linha de
  // auditoria por pessoa — só o resumo, a cargo de quem disparou a varredura.
  if (silent) return { ok: true, kind, roleId, player, replaced: replaced[0] ?? null };

  await notifyRecruitAlert(client, cfg, { player, kind, discordId: targetDiscordId });

  // Banimento não deixa rastro no log: o canal tem leitores demais.
  if (kind !== 'banned') {
    const quem = actorId
      ? `🔗 <@${actorId}> vinculou **forçadamente** <@${targetDiscordId}> → **${player.username}** (${KIND_LABEL[kind]}).`
      : `🔗 <@${targetDiscordId}> vinculou **${player.username}** → ${KIND_LABEL[kind]}.`;
    await audit(client, guildId, quem);
  }

  return { ok: true, kind, roleId, player, replaced: replaced[0] ?? null };
}

// Vincula o nick ao Discord de quem clicou e devolve o texto de confirmação
// (a interação já respondeu de forma ephemeral por quem chamou).
//
// Responde no idioma do Discord de quem clicou. O texto do BANIDO é o mesmo dos
// dois lados por um motivo: ele precisa ser indistinguível de um sucesso comum,
// e uma tradução mais seca ou mais curta já seria uma pista.
export async function linkAndClassify(interaction, rawNick) {
  const res = await performLink({
    client: interaction.client,
    guildId: interaction.guildId,
    targetDiscordId: interaction.user.id,
    targetMember: interaction.member,
    rawNick,
  });
  if (!res.ok) return pick(interaction, { pt: res.error, en: res.errorEn ?? res.error });

  const nome = res.player.username;
  // O banimento é SILENCIOSO: confirmação comum, sem citar cargo, guilda ou
  // motivo, e sem sugerir candidatura, que só chamaria atenção.
  if (res.kind === 'banned') {
    return pick(interaction, {
      pt: `Conta **${nome}** vinculada com sucesso!`,
      en: `Account **${nome}** linked successfully!`,
    });
  }

  const roleNote = res.roleId
    ? pick(interaction, { pt: ` Cargo <@&${res.roleId}> aplicado.`, en: ` Role <@&${res.roleId}> applied.` })
    : '';

  if (res.kind === 'member') {
    return pick(interaction, {
      pt: `Conta **${nome}** vinculada! Bem-vindo de volta, membro da **Wynn Brasil**.${roleNote}`,
      en: `Account **${nome}** linked! Welcome back, **Wynn Brasil** member.${roleNote}`,
    });
  }
  if (res.kind === 'ally') {
    return pick(interaction, {
      pt: `Conta **${nome}** vinculada! Você foi reconhecido como **aliado** da Wynn Brasil.${roleNote}`,
      en: `Account **${nome}** linked! You've been recognised as a Wynn Brasil **ally**.${roleNote}`,
    });
  }
  return pick(interaction, {
    pt: `Conta **${nome}** vinculada! Quer entrar na guilda? Vá ao canal de recrutamento e clique em **Enviar candidatura**.${roleNote}`,
    en: `Account **${nome}** linked! Want to join the guild? Head to the recruitment channel and click **Enviar candidatura**.${roleNote}`,
  });
}

/**
 * Vínculo forçado pela staff: registra `targetDiscordId` na conta `rawNick`,
 * sobrescrevendo vínculos conflitantes. Devolve um resumo para a staff.
 * @returns {Promise<string>}
 */
export async function forceLink({ interaction, targetUser, targetMember, rawNick }) {
  const res = await performLink({
    client: interaction.client,
    guildId: interaction.guildId,
    targetDiscordId: targetUser.id,
    targetMember,
    rawNick,
    actorId: interaction.user.id,
    force: true,
  });
  if (!res.ok) return res.error;

  const linhas = [
    `Vínculo forçado: <@${targetUser.id}> → **${res.player.username}**.`,
    `Classificação: **${KIND_LABEL[res.kind] ?? 'BANIDO'}**${res.roleId && res.kind !== 'banned' ? ` · cargo <@&${res.roleId}> aplicado` : ''}.`,
  ];
  if (res.replaced) {
    linhas.push(`⚠️ Substituiu o vínculo anterior de **${res.replaced.username}** (<@${res.replaced.discordId}>).`);
  }
  if (!targetMember) {
    linhas.push('⚠️ O usuário não está no servidor, então nenhum cargo foi aplicado — só o registro no banco.');
  }
  return linhas.join('\n');
}

/**
 * Registro em massa pelo apelido. Varre todos os membros do Discord e, para quem
 * ainda NÃO tem vínculo, olha o apelido na API do Wynn; se o jogador existir,
 * cria o vínculo — a mesma lógica do registro, só que disparada pela staff.
 *
 * Usa `force: false` de propósito: se o apelido de alguém casa com uma conta já
 * vinculada a outra pessoa, o vínculo do dono NÃO é roubado — a colisão só entra
 * no resumo. Roubar exige o `/forcelink` individual, uma decisão consciente.
 *
 * A API serializa e espaça as chamadas sozinha, então não há throttle extra
 * aqui. O que existe é um TETO de consultas por rodada: o resultado volta numa
 * interação do Discord, cujo token morre em 15 minutos, e sem teto uma varredura
 * de centenas de membros estourava esse prazo (além do rate limit). Quem passar
 * do teto fica para a próxima — é só clicar de novo.
 *
 * @param {import('discord.js').Guild} guild
 * @param {{ actorId?: string }} [opts]
 * @returns {Promise<{scanned:number, already:number, registered:number, notFound:number, invalid:number, conflicts:number, failed:number, lookups:number, remaining:number, rateLimited:boolean, byKind:{member:number, ally:number, neutral:number, banned:number}}>}
 */
export async function registerAllByNick(guild, { actorId, maxLookups = MAX_LOOKUPS_PER_RUN } = {}) {
  await guild.members.fetch().catch(() => {});
  const linked = await collections.members().find({}, { projection: { discordId: 1 } }).toArray();
  const linkedDiscord = new Set(linked.map((l) => l.discordId));

  const summary = {
    scanned: 0, already: 0, registered: 0, notFound: 0, invalid: 0, conflicts: 0, failed: 0,
    lookups: 0, remaining: 0, rateLimited: false,
    byKind: { member: 0, ally: 0, neutral: 0, banned: 0 },
  };

  for (const member of guild.members.cache.values()) {
    if (member.user.bot) continue;
    summary.scanned += 1;
    if (linkedDiscord.has(member.id)) {
      summary.already += 1;
      continue;
    }

    // Descasca a TAG: quem já foi renomeado para `[GsW] Fulano` tem `Fulano`
    // como nick, e sem isto a consulta iria com o colchete e não acharia nada.
    const rawNick = stripNickTag(member.nickname || member.user.username);

    // Apelido que não pode ser nick nem chega à API. É a maioria dos casos numa
    // varredura de servidor grande ("Ninja no celular", "joão | BR", emojis) e
    // era ele que enchia a fila de requisições inúteis.
    if (!isValidNick(rawNick)) {
      summary.invalid += 1;
      continue;
    }

    if (summary.lookups >= maxLookups) {
      summary.remaining += 1;
      continue;
    }
    summary.lookups += 1;

    const res = await performLink({
      client: guild.client,
      guildId: guild.id,
      targetDiscordId: member.id,
      targetMember: member,
      rawNick,
      actorId,
      force: false,
      silent: true,
    });

    if (res.ok) {
      summary.registered += 1;
      summary.byKind[res.kind] = (summary.byKind[res.kind] ?? 0) + 1;
    } else if (res.code === 'api_unavailable') {
      // A janela fechou. Continuar é gastar 15 minutos de interação para colher
      // "não encontrei" de gente que existe — melhor parar e dizer isso.
      summary.rateLimited = true;
      summary.remaining += 1;
      break;
    } else if (res.code === 'not_found') {
      summary.notFound += 1;
    } else if (res.code === 'invalid_nick') {
      summary.invalid += 1;
    } else if (res.code === 'conflict') {
      summary.conflicts += 1;
    } else {
      summary.failed += 1;
    }
  }

  return summary;
}

export function panelPayload() {
  return {
    embeds: [
      {
        title: '📋 Registro — Wynn Brasil [WnBR]',
        color: 0x3498db,
        description:
`Para ter acesso ao servidor, vincule sua conta do WynnCraft ao seu Discord.

**Como funciona**
> **1.** Clique no botão **Verificar minha conta** abaixo.
> **2.** Digite o seu nick do WynnCraft na janela que abrir.
> **3.** O bot consulta a API oficial e te entrega o cargo certo.

**Qual cargo você recebe**
> 🟢 Está na **Wynn Brasil** → cargo de membro, acesso completo.
> ⚪ Não está na guilda → cargo de comunidade. Depois é só clicar em **Enviar candidatura** em <#${RECRUIT_CHANNEL}>.

**O que o bot passa a rastrear**
> Seu apelido no Discord vira o seu nick, e se atualiza sozinho caso você troque de nome no jogo.
> Guild XP, guerras, guild raids e objetivos semanais viram **pontos de contribuição**, que definem a fila de Tomes e a sua margem de inatividade. O botão **Meus pontos**, em <#${STATUS_CHANNEL}>, mostra os seus.

🇬🇧 **English** — Click **Verificar minha conta** below and type your WynnCraft username. The bot checks the official API and gives you the right role: guild member, ally, or community. Your Discord nickname is set to your in-game name and kept in sync. The bot replies in English if your Discord is set to English.

-# Só você enxerga a resposta da verificação. Este canal não aceita mensagens.`,
        footer: { text: 'Dados verificados na API oficial do Wynncraft' },
      },
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(BUTTON_ID)
          .setLabel('Verificar minha conta')
          .setEmoji('✅')
          .setStyle(ButtonStyle.Success),
      ),
    ],
  };
}

export function nickModal(interaction = null) {
  return new ModalBuilder()
    .setCustomId(MODAL_ID)
    .setTitle(pick(interaction, { pt: 'Verificação de conta', en: 'Account verification' }))
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(NICK_FIELD)
          .setLabel(pick(interaction, { pt: 'Seu nick no WynnCraft', en: 'Your WynnCraft username' }))
          .setPlaceholder(pick(interaction, { pt: 'Ex.: B_Attomic', en: 'e.g. B_Attomic' }))
          .setStyle(TextInputStyle.Short)
          .setMinLength(1)
          .setMaxLength(20)
          .setRequired(true),
      ),
    );
}

export async function ensureRegistrationPanel(client, guildDiscordId) {
  const cfg = await getConfig(guildDiscordId);
  return ensurePanel(client, cfg.channels?.registration, PANEL_STATE_ID, brandWithLogo(panelPayload()), 'registro', [logoAttachment()]);
}

// Garante o painel fixo do registro. Roda periodicamente e logo após /config.
//
// A black-list NÃO recebe painel: qualquer texto ali entregaria que existe uma
// regra automática contra a GsW. O canal fica mudo de propósito.
export async function ensurePanels(client, guildDiscordId) {
  const cfg = await getConfig(guildDiscordId);
  await ensurePanel(client, cfg.channels?.registration, PANEL_STATE_ID, brandWithLogo(panelPayload()), 'registro', [logoAttachment()]);
}

// O canal de registro guarda só a mensagem do painel. Qualquer outra coisa
// postada ali é removida.
export function attachRegistrationGuard(client) {
  client.on('messageCreate', async (message) => {
    if (!message.guildId) return;

    // Nunca apagamos o que nós mesmos postamos. O painel chega aqui pelo evento
    // ANTES de ensurePanel gravar o messageId, então checar o estado salvo faria
    // o guardião apagar o painel recém-criado — e o ciclo se repetiria sem fim.
    if (message.author?.id === client.user?.id) return;

    try {
      const cfg = await getConfig(message.guildId);
      if (message.channelId !== cfg.channels?.registration) return;
      await message.delete().catch(() => {});
    } catch (e) {
      log.error('Falha ao limpar o canal de registro:', e);
    }
  });
}
