import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import { collections } from '../db/mongo.js';
import { fetchGuildMembers, RANKS, RANK_LABEL } from './guildData.js';
import {
  applyClassificationRoles,
  syncNickname,
  expectedNickname,
  stripNickTag,
} from './registration.js';
import { loadGuildIndex } from './guildList.js';
import { ensureAllyRole, syncAllyIdentity } from './allyRoles.js';
import { loadBanIndex, recordBan, exemptInIndex, BAN_REASON_BLACKLIST_GUILD } from './bans.js';
import { getConfig } from '../config/guildConfig.js';
import { optional } from '../config/env.js';

/**
 * Painel de reconciliação: varre TODOS os membros do Discord, deduz o cargo de
 * classificação correto de cada um a partir do apelido/vínculo e cruza com o que
 * a pessoa realmente tem. Diferente do /verificar (que só lê a coleção de
 * vínculos), aqui a fonte é o próprio servidor do Discord.
 *
 * Custa uma chamada à API por guilda rastreada (a nossa + cada black-list + cada
 * aliada), nunca uma por membro. A identidade é resolvida por, nesta ordem:
 * vínculo salvo → apelido casado contra os rosters → coleção de membros por
 * username.
 *
 * O apelido também é cobrado, e aí a comparação é EXATA — inclusive na caixa.
 * Identificar a pessoa continua sendo caso-insensível (é o que a acha), mas
 * `b_attomic` no Discord com `B_Attomic` no jogo é divergência, e o painel
 * corrige junto com o cargo.
 */

const CLASSIFICATION_KEYS = ['community', 'guildMember', 'banned'];

const KIND_LABEL = {
  member: 'Membro',
  ally: 'Aliado',
  neutral: 'Comunidade',
  banned: 'Banido',
  unregistered: 'Sem registro',
};
const KIND_EMOJI = { member: '🟢', ally: '🤝', neutral: '⚪', banned: '🚫', unregistered: '❔' };

/** Cargos que cada classificação DEVE ter (espelha registration.js). */
const ROLES_BY_KIND = {
  member: ['guildMember', 'community'],
  ally: ['community'],
  neutral: ['community'],
  banned: ['banned'],
  // Nenhum. Ver a nota em registration.js: comunidade atesta um registro, e
  // quem não tem vínculo nem aparece em roster nenhum não tem o que atestar.
  unregistered: [],
};

/** Normaliza para casar nome de cargo/nick sem tropeçar em acento ou caixa. */
function norm(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** Nomes de cargo que denotam um RANK da guilda (todo rank exige estar na guilda). */
const RANK_NAMES = new Set([...RANKS.map(norm), ...Object.values(RANK_LABEL).map(norm)]);

/** IDs dos cargos do servidor cujo nome bate com um rank da guilda. */
function rankRoleIds(guild) {
  const ids = new Set();
  for (const role of guild.roles.cache.values()) {
    if (RANK_NAMES.has(norm(role.name))) ids.add(role.id);
  }
  return ids;
}

/**
 * Deduz o `kind` correto de um membro do Discord a partir do apelido e do
 * vínculo, cruzando com os rosters e a lista de bans.
 */
function resolveKind({ nickLower, uuid, discordId, linked }, ctx) {
  const { guildUuids, guildNames, blUuids, blNames, allyByUuid, allyByName, ban } = ctx;
  const banned = ban.discordIds.has(discordId) || (uuid && ban.uuids.has(uuid));
  const inBlacklist = (uuid && blUuids.has(uuid)) || blNames.has(nickLower);
  const isOurs = (uuid && guildUuids.has(uuid)) || guildNames.has(nickLower);
  const isAlly = (uuid && allyByUuid.has(uuid)) || allyByName.has(nickLower);
  // Isento pela staff continua na guilda proibida, e é essa a ideia:
  // `inBlacklist` sozinho não pode bastar, senão a reconciliação rebaixaria a
  // pessoa a banido de novo sem nem consultar a lista.
  if (exemptInIndex(ban, { uuid, discordId })) {
    return isOurs ? 'member' : isAlly ? 'ally' : 'neutral';
  }
  if (banned || inBlacklist) return 'banned';
  if (isOurs) return 'member';
  if (isAlly) return 'ally';

  // Aqui está a diferença entre "não está em guilda nenhuma" e "não existe para
  // o bot". Neutro é quem SE REGISTROU e não entrou em guilda alguma; o cargo de
  // comunidade é o que atesta esse registro.
  //
  // Quem não tem vínculo e cujo apelido não casa com roster nenhum nunca provou
  // ser dono de conta do WynnCraft — e apelido de Discord não é nick: `Ninja no
  // celular` tem espaços, coisa que nick do Minecraft não pode ter. Antes disto
  // essa pessoa caía em 'neutral' e o painel oferecia dar comunidade a ela.
  return linked ? 'neutral' : 'unregistered';
}

/** A guilda aliada deste jogador e o cargo dela, ou nulos. */
function allyFor({ nickLower, uuid }, ctx) {
  const doc = (uuid && ctx.allyByUuid.get(uuid)) || ctx.allyByName.get(nickLower) || null;
  return { doc, roleId: doc ? ctx.allyRoleByGuild.get(doc.uuid) ?? null : null };
}

/**
 * A TAG que vai na frente do apelido: a da guilda RASTREADA da pessoa, aliada ou
 * proibida. Independe da classificação — quem está na guilda proibida carrega a
 * TAG dela mesmo isento pela staff.
 */
function nickTagFor({ nickLower, uuid }, ctx) {
  const proibida = (uuid && ctx.blByUuid.get(uuid)) || ctx.blByName.get(nickLower);
  if (proibida) return proibida.prefix;
  const aliada = (uuid && ctx.allyByUuid.get(uuid)) || ctx.allyByName.get(nickLower);
  return aliada?.prefix ?? null;
}

/**
 * Monta o retrato completo. Não mexe em membro nenhum — só descreve.
 *
 * A uma exceção: os cargos `[TAG] Nome` das guildas aliadas são criados aqui se
 * ainda não existirem. Sem o cargo não há com o que comparar, e o painel diria
 * "tudo certo" para um aliado que não tem cargo nenhum. A operação é idempotente
 * e não toca em ninguém — cria o cargo, não o distribui.
 *
 * @param {import('discord.js').Guild} guild
 * @returns {Promise<object|null>}
 */
export async function computeReconciliation(guild) {
  const prefix = optional('WYNN_GUILD_PREFIX');
  if (!prefix) return null;

  const cfg = await getConfig(guild.id);
  const roleIds = {
    community: cfg.roles?.community,
    guildMember: cfg.roles?.guildMember,
    banned: cfg.roles?.banned,
  };

  const ours = await fetchGuildMembers(prefix);
  if (!ours) return null;

  const tracked = await loadGuildIndex();

  // Grafia OFICIAL de cada nick, como a API a escreve. É contra isto que o
  // apelido do Discord é comparado — com caixa e tudo. Alimentado por todo
  // roster que passar por aqui.
  const canonicalByUuid = new Map();
  const canonicalByName = new Map();
  // Índice reverso do apelido para o uuid. Sem ele, um banido identificado só
  // pelo nome entraria em `recordBan` sem uuid — e `recordBan` exige uuid.
  const uuidByName = new Map();
  const remember = (m) => {
    if (m.uuid) {
      canonicalByUuid.set(m.uuid, m.username);
      uuidByName.set(norm(m.username), m.uuid);
    }
    canonicalByName.set(norm(m.username), m.username);
  };
  for (const m of ours.members) remember(m);

  // Black-list: a união de todas as guildas proibidas. Guardamos o documento por
  // jogador (e não só o uuid) porque a TAG dele vai para o apelido.
  const blUuids = new Set();
  const blNames = new Set();
  const blByUuid = new Map();
  const blByName = new Map();
  for (const doc of tracked.blacklist) {
    const roster = await fetchGuildMembers(doc.prefix).catch(() => null);
    if (!roster) continue;
    for (const m of roster.members) {
      blUuids.add(m.uuid);
      blNames.add(norm(m.username));
      blByUuid.set(m.uuid, doc);
      blByName.set(norm(m.username), doc);
      remember(m);
    }
  }

  // Aliadas: cada jogador aponta para o documento da guilda dele, e cada guilda
  // para o cargo `[TAG] Nome` correspondente.
  const allyByUuid = new Map();
  const allyByName = new Map();
  const allyRoleByGuild = new Map();
  for (let doc of tracked.ally) {
    const roster = await fetchGuildMembers(doc.prefix).catch(() => null);
    if (!roster) continue;
    doc = await syncAllyIdentity(doc, roster.guild);
    const roleId = await ensureAllyRole(guild, cfg, doc);
    if (roleId) allyRoleByGuild.set(doc.uuid, roleId);
    for (const m of roster.members) {
      allyByUuid.set(m.uuid, doc);
      allyByName.set(norm(m.username), doc);
      remember(m);
    }
  }

  const ban = await loadBanIndex();
  const links = await collections.members().find({}).toArray();
  await guild.members.fetch().catch(() => {});

  const ctx = {
    guildUuids: new Set(ours.members.map((m) => m.uuid)),
    guildNames: new Set(ours.members.map((m) => norm(m.username))),
    blUuids,
    blNames,
    blByUuid,
    blByName,
    allyByUuid,
    allyByName,
    allyRoleByGuild,
    ban,
  };
  const linkByDiscord = new Map(links.map((l) => [l.discordId, l]));
  const linkByName = new Map(links.map((l) => [norm(l.username), l]));
  const rankIds = rankRoleIds(guild);

  const buckets = {
    toMember: [], // deveria ser Membro (ganha guilda+comunidade)
    toAlly: [], // deveria ser Aliado (comunidade + cargo [TAG])
    toNeutral: [], // deveria ser só Comunidade (perde cargo de guilda indevido)
    toBanned: [], // deveria ser Banido
    toUnregistered: [], // não tem registro: perde os cargos de classificação
    rankWithoutGuild: [], // tem cargo de rank sem estar na guilda (só aviso)
  };
  let okCount = 0;

  for (const member of guild.members.cache.values()) {
    if (member.user.bot) continue;
    const nick = member.nickname || member.user.username;
    // A TAG é descascada só para IDENTIFICAR: `[GsW] Fulano` é o Fulano do
    // roster. O `nick` original continua sendo o que se compara com o esperado.
    const nickLower = norm(stripNickTag(nick));
    const link = linkByDiscord.get(member.id);
    const uuid = link?.uuid ?? matchUuid(nickLower, uuidByName, linkByName);
    let kind = resolveKind({ nickLower, uuid, discordId: member.id, linked: !!link }, ctx);

    // Banimento é PERMANENTE: quem já carrega o cargo de banido não o perde por
    // reconciliação. Sair da guilda proibida não devolve o acesso sozinho — a
    // remoção só vem de /ban remove, depois de uma apelação. (Mesma regra do
    // roleSync/bans.js.)
    //
    // O isento é a exceção, e ela precisa estar AQUI também: entre o /ban remove
    // e o roleSync que tira o cargo existe uma janela em que a pessoa ainda o
    // carrega. Sem esta ressalva, o cargo remanescente se reafirmaria como
    // banido e o painel recriaria o banimento que a staff acabou de tirar.
    const exempt = exemptInIndex(ctx.ban, { uuid, discordId: member.id });
    if (!exempt && roleIds.banned && member.roles.cache.has(roleIds.banned)) kind = 'banned';

    // Estado atual x desejado, só nos três cargos de classificação.
    const wantedKeys = ROLES_BY_KIND[kind];
    const wantedIds = new Set(wantedKeys.map((k) => roleIds[k]).filter(Boolean));
    const holds = CLASSIFICATION_KEYS.filter((k) => roleIds[k] && member.roles.cache.has(roleIds[k]));
    const holdIds = new Set(holds.map((k) => roleIds[k]));

    // O cargo `[TAG] Nome` entra na conta junto: um aliado sem o cargo da guilda
    // dele está tão fora de sincronia quanto um membro sem o cargo de membro.
    const ally = kind === 'ally' ? allyFor({ nickLower, uuid }, ctx) : { doc: null, roleId: null };
    const allyRoleId = ally.roleId;
    const allyOk =
      (!allyRoleId || member.roles.cache.has(allyRoleId)) &&
      ![...ctx.allyRoleByGuild.values()].some((id) => id !== allyRoleId && member.roles.cache.has(id));

    const rolesInSync =
      wantedIds.size === holdIds.size &&
      [...wantedIds].every((id) => holdIds.has(id)) &&
      allyOk;

    // Apelido: comparação EXATA contra a grafia da API, caixa inclusa. Achar a
    // pessoa continua sendo caso-insensível (norm), mas `b_attomic` no Discord
    // com `B_Attomic` no jogo é divergência.
    //
    // `member.nickname` é null quando não há apelido definido — e aí o certo é
    // definir um, não deixar o username global valendo por acaso. Sem grafia
    // conhecida (nick que não casa com roster nem vínculo) não há o que cobrar.
    const nickReal = link?.username ?? (uuid ? canonicalByUuid.get(uuid) : null) ?? canonicalByName.get(nickLower) ?? null;
    // Quem é de guilda rastreada carrega a TAG na frente. Vem da mesma função
    // que o registro e o roleSync usam, senão os três ficariam se corrigindo em
    // círculo — um escreve `[GsW] Fulano`, o outro "conserta" para `Fulano`.
    const canonical = nickReal ? expectedNickname(nickReal, nickTagFor({ nickLower, uuid }, ctx)) : null;
    const nickWrong = !!canonical && member.nickname !== canonical;

    const inSync = rolesInSync && !nickWrong;

    // Aviso: segura um cargo de rank sem estar na guilda (ex.: Recrutador).
    if (kind !== 'member') {
      const heldRank = [...member.roles.cache.values()].filter((r) => rankIds.has(r.id));
      if (heldRank.length) {
        buckets.rankWithoutGuild.push({
          discordId: member.id,
          nick,
          roles: heldRank.map((r) => r.name).join(', '),
        });
      }
    }

    if (inSync) {
      okCount += 1;
      continue;
    }

    const entry = {
      discordId: member.id,
      nick,
      uuid,
      kind,
      holds, // chaves que ele tem hoje
      allyRoleId,
      allyGuildUuid: ally.doc?.uuid ?? null,
      canonical, // grafia oficial do nick (null = desconhecida)
      nickWrong,
      rolesInSync,
    };
    if (kind === 'member') buckets.toMember.push(entry);
    else if (kind === 'banned') buckets.toBanned.push(entry);
    else if (kind === 'ally') buckets.toAlly.push(entry);
    else if (kind === 'unregistered') buckets.toUnregistered.push(entry);
    else buckets.toNeutral.push(entry);
  }

  return { buckets, okCount, cfg, roleIds, guildName: ours.guild.name, prefix };
}

/**
 * Tenta achar o UUID do jogador a partir do apelido, sem chamar a API. Os
 * rosters (nossa guilda, black-lists e aliadas) já foram varridos em
 * `uuidByName`; a coleção de vínculos é o último recurso.
 */
function matchUuid(nickLower, uuidByName, linkByName) {
  return uuidByName.get(nickLower) ?? linkByName.get(nickLower)?.uuid ?? null;
}

/** Todos os desalinhados, em ordem de exibição. */
function outOfSync(buckets) {
  return [
    ...buckets.toBanned,
    ...buckets.toMember,
    ...buckets.toAlly,
    ...buckets.toNeutral,
    ...buckets.toUnregistered,
  ];
}

function block(list, render, max = 1000) {
  if (!list.length) return null;
  const s = list.map(render).join('\n');
  return s.length > max ? `${s.slice(0, max)} …` : s;
}

/**
 * Embed + componentes do painel. Stateless: os botões recomputam na hora.
 * @param {object} data  saída de computeReconciliation
 */
export function reconciliationPanel(data, note = null) {
  const { buckets, okCount, guildName, prefix } = data;
  const pending = outOfSync(buckets);
  const fields = [];

  const add = (emoji, label, list, render) => {
    const v = block(list, render);
    if (v) fields.push({ name: `${emoji} ${label} (${list.length})`, value: v });
  };

  add('🟢', 'Membro — a corrigir', buckets.toMember, renderEntry);
  add('🤝', 'Aliado — a corrigir', buckets.toAlly, renderEntry);
  add('⚪', 'Comunidade — a corrigir', buckets.toNeutral, renderEntry);
  add('🚫', 'Banimento — a corrigir', buckets.toBanned, renderEntry);
  add('❔', 'Sem registro — vão PERDER os cargos', buckets.toUnregistered, (e) =>
    `**${e.nick}** — tem: ${holdLabel(e.holds)}`,
  );
  add('⚠️', 'Cargo de rank sem estar na guilda', buckets.rankWithoutGuild, (e) => `**${e.nick}** — ${e.roles}`);

  if (!fields.length) {
    fields.push({ name: '✅ Tudo sincronizado', value: 'Nenhum cargo nem apelido a corrigir.' });
  }

  const nickCount = pending.filter((e) => e.nickWrong).length;
  const embed = {
    title: `🔧 Reconciliação — ${guildName} [${prefix}]`,
    color: 0x9b59b6,
    description:
      note ??
      `Cruzando o **vínculo** de cada membro do Discord com a guilda, as aliadas, a black-list e a lista de bans.\n` +
        `**${okCount}** já corretos · **${pending.length}** a corrigir${nickCount ? ` (${nickCount} por apelido)` : ''}.`,
    fields,
    footer: {
      text: 'Sem registro = sem cargo: comunidade atesta um vínculo. Apelido é comparado letra por letra, maiúscula inclusa.',
    },
    timestamp: new Date().toISOString(),
  };

  const components = [];
  // Cinco classificações e o "Tudo" não cabem numa linha só (o Discord aceita 5
  // botões por linha), então o "Tudo" desceu para a segunda.
  const row1 = new ActionRowBuilder();
  if (buckets.toMember.length) row1.addComponents(btn('recon:apply:member', `Membro (${buckets.toMember.length})`, ButtonStyle.Success, '🟢'));
  if (buckets.toAlly.length) row1.addComponents(btn('recon:apply:ally', `Aliado (${buckets.toAlly.length})`, ButtonStyle.Secondary, '🤝'));
  if (buckets.toNeutral.length) row1.addComponents(btn('recon:apply:neutral', `Comunidade (${buckets.toNeutral.length})`, ButtonStyle.Secondary, '⚪'));
  if (buckets.toBanned.length) row1.addComponents(btn('recon:apply:banned', `Banir (${buckets.toBanned.length})`, ButtonStyle.Danger, '🚫'));
  if (buckets.toUnregistered.length) row1.addComponents(btn('recon:apply:unregistered', `Sem registro (${buckets.toUnregistered.length})`, ButtonStyle.Danger, '❔'));
  if (row1.components.length) components.push(row1);

  const row2 = new ActionRowBuilder();
  if (pending.length) row2.addComponents(btn('recon:apply:all', `Tudo (${pending.length})`, ButtonStyle.Primary, '⚡'));
  row2.addComponents(
    btn('recon:register', 'Registrar todos pelo apelido', ButtonStyle.Primary, '🔗'),
    btn('recon:refresh', 'Atualizar', ButtonStyle.Secondary, '🔄'),
  );
  components.push(row2);

  // Menu para escolher indivíduos (limite de 25 do Discord).
  if (pending.length) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId('recon:select')
      .setPlaceholder('Aplicar a jogadores específicos…')
      .setMinValues(1)
      .setMaxValues(Math.min(pending.length, 25))
      .addOptions(
        pending.slice(0, 25).map((e) => ({
          label: (e.canonical ?? e.nick).slice(0, 100),
          value: e.discordId,
          description: `→ ${KIND_LABEL[e.kind]}${e.nickWrong ? ' · corrige apelido' : ''}`.slice(0, 100),
          emoji: KIND_EMOJI[e.kind],
        })),
      );
    components.push(new ActionRowBuilder().addComponents(menu));
  }

  return { embeds: [embed], components };
}

/**
 * Uma linha do painel. Quem está listado só por causa do apelido não pode
 * aparecer como se fosse trocar de cargo — o marcador diz o que de fato muda.
 */
function renderEntry(e) {
  const partes = [];
  if (!e.rolesInSync) partes.push(`tem: ${holdLabel(e.holds)}`);
  if (e.nickWrong) partes.push(`apelido: \`${e.nick}\` → \`${e.canonical}\``);
  return `**${e.canonical ?? e.nick}** — ${partes.join(' · ')}`;
}

function holdLabel(holds) {
  if (!holds.length) return 'nenhum';
  const map = { community: 'comunidade', guildMember: 'guilda', banned: 'banido' };
  return holds.map((k) => map[k] ?? k).join(' + ');
}

function btn(id, label, style, emoji) {
  return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setEmoji(emoji);
}

/**
 * Aplica a classificação correta e devolve o retrato atualizado para re-render.
 * @param {import('discord.js').Guild} guild
 * @param {'member'|'ally'|'neutral'|'banned'|'all'} scope  qual grupo aplicar
 * @param {string[]|null} only  restringe a estes discordIds (menu de seleção)
 * @returns {Promise<{applied:number, data:object}>}
 */
export async function applyReconciliation(guild, scope, only = null) {
  const data = await computeReconciliation(guild);
  if (!data) return { applied: 0, data: null };

  const { buckets, cfg } = data;
  let targets = outOfSync(buckets);
  if (scope !== 'all') targets = targets.filter((e) => e.kind === scope);
  if (only) {
    const set = new Set(only);
    targets = targets.filter((e) => set.has(e.discordId));
  }

  let applied = 0;
  for (const e of targets) {
    const member = guild.members.cache.get(e.discordId) || (await guild.members.fetch(e.discordId).catch(() => null));
    if (!member) continue;
    await applyClassificationRoles(member, cfg, e.kind, e.allyRoleId);
    // Apelido exato. Só quando sabemos a grafia oficial — renomear para um
    // palpite seria pior que deixar como está.
    if (e.nickWrong && e.canonical) await syncNickname(member, e.canonical);
    // Detectou guilda proibida/banido? Grava o banimento PERMANENTE (uuid +
    // discord). Assim, sair da guilda depois não devolve o acesso — a remoção só
    // vem de /ban remove.
    if (e.kind === 'banned' && e.uuid) {
      await recordBan({ uuid: e.uuid, username: e.canonical ?? e.nick, discordId: e.discordId, reason: BAN_REASON_BLACKLIST_GUILD });
    }
    // Mantém a coleção de vínculos coerente com /verificar (só se já houver
    // vínculo). Quem está como 'unregistered' não tem vínculo por definição —
    // gravar classificação para ele seria inventar o registro que ele não tem.
    if (e.kind !== 'unregistered') {
      await collections.members().updateOne(
        { discordId: e.discordId },
        { $set: { classification: e.kind, allyGuildUuid: e.allyGuildUuid ?? null } },
      );
    }
    applied += 1;
  }

  // Retrato fresco depois das mudanças, para o painel refletir a realidade.
  const after = await computeReconciliation(guild);
  return { applied, data: after ?? data };
}
