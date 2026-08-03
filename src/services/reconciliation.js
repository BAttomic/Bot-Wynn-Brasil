import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import { collections } from '../db/mongo.js';
import { fetchGuildMembers, RANKS, RANK_LABEL } from './guildData.js';
import { applyClassificationRoles, blacklistGuild } from './registration.js';
import { loadBanIndex, recordBan, exemptInIndex, BAN_REASON_BLACKLIST_GUILD } from './bans.js';
import { getConfig } from '../config/guildConfig.js';
import { optional } from '../config/env.js';

/**
 * Painel de reconciliação: varre TODOS os membros do Discord, deduz o cargo de
 * classificação correto de cada um a partir do apelido/vínculo e cruza com o que
 * a pessoa realmente tem. Diferente do /verificar (que só lê a coleção de
 * vínculos), aqui a fonte é o próprio servidor do Discord.
 *
 * Custa 2 chamadas à API (roster da nossa guilda + roster da black-list), nunca
 * uma por membro. A identidade é resolvida por, nesta ordem: vínculo salvo →
 * apelido casado contra os rosters → coleção de membros por username.
 */

const CLASSIFICATION_KEYS = ['community', 'guildMember', 'banned'];

const KIND_LABEL = { member: 'Membro', neutral: 'Comunidade', banned: 'Banido' };
const KIND_EMOJI = { member: '🟢', neutral: '⚪', banned: '🚫' };

/** Cargos que cada classificação DEVE ter (espelha registration.js). */
const ROLES_BY_KIND = {
  member: ['guildMember', 'community'],
  neutral: ['community'],
  banned: ['banned'],
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
function resolveKind({ nickLower, uuid, discordId }, ctx) {
  const { guildUuids, guildNames, blUuids, blNames, ban } = ctx;
  const banned = ban.discordIds.has(discordId) || (uuid && ban.uuids.has(uuid));
  const inBlacklist = (uuid && blUuids.has(uuid)) || blNames.has(nickLower);
  // Isento pela staff continua na GsW, e é essa a ideia: `inBlacklist` sozinho
  // não pode bastar, senão a reconciliação rebaixaria a pessoa a banido de novo
  // sem nem consultar a lista.
  if (exemptInIndex(ban, { uuid, discordId })) {
    return (uuid && guildUuids.has(uuid)) || guildNames.has(nickLower) ? 'member' : 'neutral';
  }
  if (banned || inBlacklist) return 'banned';
  if ((uuid && guildUuids.has(uuid)) || guildNames.has(nickLower)) return 'member';
  return 'neutral';
}

/**
 * Monta o retrato completo. Não aplica nada — só descreve.
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
  const bl = await fetchGuildMembers(blacklistGuild().prefix).catch(() => null);
  const ban = await loadBanIndex();
  const links = await collections.members().find({}).toArray();
  await guild.members.fetch().catch(() => {});

  const ctx = {
    guildUuids: new Set(ours.members.map((m) => m.uuid)),
    guildNames: new Set(ours.members.map((m) => norm(m.username))),
    blUuids: new Set(bl?.members.map((m) => m.uuid) ?? []),
    blNames: new Set(bl?.members.map((m) => norm(m.username)) ?? []),
    ban,
  };
  const linkByDiscord = new Map(links.map((l) => [l.discordId, l]));
  const linkByName = new Map(links.map((l) => [norm(l.username), l]));
  const rankIds = rankRoleIds(guild);

  const buckets = {
    toMember: [], // deveria ser Membro (ganha guilda+comunidade)
    toNeutral: [], // deveria ser só Comunidade (perde cargo de guilda indevido)
    toBanned: [], // deveria ser Banido
    rankWithoutGuild: [], // tem cargo de rank sem estar na guilda (só aviso)
  };
  let okCount = 0;

  for (const member of guild.members.cache.values()) {
    if (member.user.bot) continue;
    const nick = member.nickname || member.user.username;
    const nickLower = norm(nick);
    const link = linkByDiscord.get(member.id);
    const uuid = link?.uuid ?? matchUuid(nickLower, ours, bl, linkByName);
    let kind = resolveKind({ nickLower, uuid, discordId: member.id }, ctx);

    // Banimento é PERMANENTE: quem já carrega o cargo de banido não o perde por
    // reconciliação. Sair da GsW não devolve o acesso sozinho — a remoção só vem
    // de /ban remove, depois de uma apelação. (Mesma regra do roleSync/bans.js.)
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

    const inSync =
      wantedIds.size === holdIds.size && [...wantedIds].every((id) => holdIds.has(id));

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
    };
    if (kind === 'member') buckets.toMember.push(entry);
    else if (kind === 'banned') buckets.toBanned.push(entry);
    else buckets.toNeutral.push(entry);
  }

  return { buckets, okCount, cfg, roleIds, guildName: ours.guild.name, prefix };
}

/** Tenta achar o UUID do jogador a partir do apelido, sem chamar a API. */
function matchUuid(nickLower, ours, bl, linkByName) {
  const inOurs = ours.members.find((m) => norm(m.username) === nickLower);
  if (inOurs) return inOurs.uuid;
  const inBl = bl?.members.find((m) => norm(m.username) === nickLower);
  if (inBl) return inBl.uuid;
  return linkByName.get(nickLower)?.uuid ?? null;
}

/** Todos os desalinhados, em ordem de exibição. */
function outOfSync(buckets) {
  return [...buckets.toBanned, ...buckets.toMember, ...buckets.toNeutral];
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

  add('🟢', 'Vão receber cargo de Membro', buckets.toMember, (e) => `**${e.nick}** — tem: ${holdLabel(e.holds)}`);
  add('⚪', 'Vão ficar só como Comunidade', buckets.toNeutral, (e) => `**${e.nick}** — tem: ${holdLabel(e.holds)}`);
  add('🚫', 'Vão receber banimento', buckets.toBanned, (e) => `**${e.nick}** — tem: ${holdLabel(e.holds)}`);
  add('⚠️', 'Cargo de rank sem estar na guilda', buckets.rankWithoutGuild, (e) => `**${e.nick}** — ${e.roles}`);

  if (!fields.length) {
    fields.push({ name: '✅ Tudo sincronizado', value: 'Nenhum cargo a corrigir.' });
  }

  const embed = {
    title: `🔧 Reconciliação de cargos — ${guildName} [${prefix}]`,
    color: 0x9b59b6,
    description: note ?? `Cruzando o apelido de cada membro do Discord com a guilda, a black-list e a lista de bans.\n**${okCount}** já corretos · **${pending.length}** a corrigir.`,
    fields,
    footer: { text: 'Cargos de rank são gestão manual — o bot só avisa, não mexe.' },
    timestamp: new Date().toISOString(),
  };

  const components = [];
  const row1 = new ActionRowBuilder();
  if (buckets.toMember.length) row1.addComponents(btn('recon:apply:member', `Membro (${buckets.toMember.length})`, ButtonStyle.Success, '🟢'));
  if (buckets.toNeutral.length) row1.addComponents(btn('recon:apply:neutral', `Comunidade (${buckets.toNeutral.length})`, ButtonStyle.Secondary, '⚪'));
  if (buckets.toBanned.length) row1.addComponents(btn('recon:apply:banned', `Banir (${buckets.toBanned.length})`, ButtonStyle.Danger, '🚫'));
  if (row1.components.length) {
    row1.addComponents(btn('recon:apply:all', `Tudo (${pending.length})`, ButtonStyle.Primary, '⚡'));
    components.push(row1);
  }
  components.push(new ActionRowBuilder().addComponents(
    btn('recon:register', 'Registrar todos pelo apelido', ButtonStyle.Primary, '🔗'),
    btn('recon:refresh', 'Atualizar', ButtonStyle.Secondary, '🔄'),
  ));

  // Menu para escolher indivíduos (limite de 25 do Discord).
  if (pending.length) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId('recon:select')
      .setPlaceholder('Aplicar a jogadores específicos…')
      .setMinValues(1)
      .setMaxValues(Math.min(pending.length, 25))
      .addOptions(
        pending.slice(0, 25).map((e) => ({
          label: e.nick.slice(0, 100),
          value: e.discordId,
          description: `→ ${KIND_LABEL[e.kind]}`,
          emoji: KIND_EMOJI[e.kind],
        })),
      );
    components.push(new ActionRowBuilder().addComponents(menu));
  }

  return { embeds: [embed], components };
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
 * @param {'member'|'neutral'|'banned'|'all'} scope  qual grupo aplicar
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
    await applyClassificationRoles(member, cfg, e.kind);
    // Detectou GsW/banido? Grava o banimento PERMANENTE (uuid + discord). Assim,
    // sair da GsW depois não devolve o acesso — a remoção só vem de /ban remove.
    if (e.kind === 'banned' && e.uuid) {
      await recordBan({ uuid: e.uuid, username: e.nick, discordId: e.discordId, reason: BAN_REASON_BLACKLIST_GUILD });
    }
    // Mantém a coleção de vínculos coerente com /verificar (só se já houver vínculo).
    await collections.members().updateOne({ discordId: e.discordId }, { $set: { classification: e.kind } });
    applied += 1;
  }

  // Retrato fresco depois das mudanças, para o painel refletir a realidade.
  const after = await computeReconciliation(guild);
  return { applied, data: after ?? data };
}
