import { getConfig } from '../config/guildConfig.js';
import { collections } from '../db/mongo.js';
import { log } from '../util/log.js';

/**
 * Reaction-role dos cargos de ping.
 *
 * Cada grupo vira UMA mensagem no canal de pings. O bot reage nela com uma letra
 * por cargo (🇦, 🇧, 🇨…), e mantém a associação letra→cargo. Reagiu = ganha o
 * cargo; tirou a reação = perde. O menu nativo <id:customize> foi removido do
 * servidor, então é assim que o membro se auto-atribui agora.
 *
 * Um cargo SEM id é omitido (nem entra na lista, nem consome uma letra), o que
 * deixa o slot pronto para receber o id depois sem quebrar as posições.
 */

// Indicadores regionais A–T = 20, exatamente o teto de reações por mensagem do
// Discord. Todos os grupos aqui cabem folgado.
const LETTERS = Object.freeze([
  '🇦', '🇧', '🇨', '🇩', '🇪', '🇫', '🇬', '🇭', '🇮', '🇯',
  '🇰', '🇱', '🇲', '🇳', '🇴', '🇵', '🇶', '🇷', '🇸', '🇹',
]);

const COLOR = 0xe67e22;
const SILENT = { allowedMentions: { parse: [] } };

/**
 * @typedef {object} PingRole
 * @property {string} id     id do cargo; '' = slot vazio, é ignorado
 * @property {string} [todo] nome legível, só para o slot que ainda espera id
 *
 * @typedef {object} PingGroup
 * @property {string}     key    identificador estável (vira o stateId da mensagem)
 * @property {string}     title
 * @property {string}     [note] linha de contexto acima da lista
 * @property {PingRole[]} roles
 *
 * @type {ReadonlyArray<PingGroup>}
 */
export const PING_GROUPS = Object.freeze([
  {
    key: 'xp',
    title: '1. Pings de Experiência (XP)',
    roles: [
      { id: '1268213746585698375' },
      { id: '1268211113942847603' },
      { id: '1268209833090486423' },
      { id: '1268209831219560560' },
      { id: '1268209827457400844' },
      { id: '1268208726058205245' },
      { id: '1268208320452235306' },
      { id: '1268208320343445516' },
      { id: '', todo: 'PING GUILD XP' },
      { id: '', todo: 'PING XP - Fruma Lighthouse (115+)' },
      { id: '', todo: 'PING XP - Fruma BatCave (107+)' },
    ],
  },
  {
    key: 'dungeon',
    title: '2. Pings de Dungeon',
    roles: [
      { id: '1268218114999586816' },
      { id: '1268218115402109049' },
      { id: '1268218120196325517' },
      { id: '1268218114043019425' },
      { id: '1268220280166420572' },
      { id: '1268220287510384653' },
      { id: '1268220291788574814' },
      { id: '1268218121324462226' },
      { id: '1268218113137311877' },
      { id: '1268218101682405396' },
      { id: '1268218112319291462' },
    ],
  },
  {
    key: 'prof',
    title: '3. Pings de Profissões',
    note: 'Peça para alguém coletar um recurso ou craftar um item para você.',
    roles: [
      { id: '1331682928979218462' },
      { id: '1331682931940528188' },
      { id: '1331682925401473095' },
      { id: '1331682920431226892' },
      { id: '1331682933265793096' },
      { id: '1331682936629497907' },
      { id: '1331682933655867472' },
      { id: '1331682934901444649' },
      { id: '1331682934259978445' },
      { id: '1331682935937564692' },
      { id: '1331682935627190283' },
      { id: '1331682937309102191' },
    ],
  },
  {
    key: 'raids',
    title: '4. Pings de Quests e Raids',
    note: 'Convide outros membros para participar com você.',
    roles: [
      { id: '1271168738002997279' },
      { id: '1269810703972171908' },
      { id: '1269810688352718918' },
      { id: '1268229834455253013' },
      { id: '1268229845398327417' },
      { id: '1268229846144647170' },
      { id: '1268229847075786853' },
      { id: '', todo: 'PING RAID - The Wartorn Palace (119+)' },
    ],
  },
  {
    key: 'classes',
    title: '5. Pings de Classes e Eventos',
    note: 'Encontre jogadores da mesma classe ou fique por dentro dos eventos.',
    roles: [
      { id: '1269826644693221466' },
      { id: '1269826646886584413' },
      { id: '1269826649386385520' },
      { id: '1269826651878068374' },
      { id: '1269826654381805669' },
      { id: '1273252381018165308' },
      { id: '1295760021375815701' },
    ],
  },
  {
    key: 'bombs',
    title: '6. Pings de Bombas',
    note: 'Seja avisado quando uma bomba estiver ativa no servidor.',
    roles: [
      { id: '', todo: 'PING BOMBS - Champion' },
    ],
  },
]);

/** stateId da mensagem-cabeçalho e de cada grupo, no watcherState. */
const HEADER_STATE = 'pingsHeader';
const groupState = (key) => `pingGroup:${key}`;
const LEGACY_STATE = 'pingsPanel'; // painel único antigo, substituído por este sistema

/** Todos os stateIds que este sistema mantém. */
export const PING_STATE_IDS = Object.freeze([
  HEADER_STATE,
  ...PING_GROUPS.map((g) => groupState(g.key)),
]);

/**
 * Cargos com id, na ordem, com a letra que cada um recebe. Slots vazios não
 * entram, então as letras ficam sempre contíguas.
 * @param {PingGroup} g
 * @returns {Array<{id: string, emoji: string}>}
 */
function assign(g) {
  return g.roles
    .filter((r) => r.id)
    .slice(0, LETTERS.length)
    .map((r, i) => ({ id: r.id, emoji: LETTERS[i] }));
}

/**
 * messageId -> (emoji -> roleId). Reconstruído a cada ciclo de `ensure`; é o que
 * o handler de reação consulta.
 * @type {Map<string, Map<string, string>>}
 */
const roleByMessage = new Map();

function headerPayload() {
  return {
    ...SILENT,
    embeds: [
      {
        title: '🔔 Auto-Role & Pings: Personalize Suas Notificações',
        color: COLOR,
        description:
`Selecione seus cargos para receber notificações apenas sobre o que interessa a você.

### 📌 Objetivo
> Melhorar a comunicação e a organização da comunidade. Marcando cargos, você recebe ping só dos assuntos que acompanha.

### 📥 Como pegar um cargo?
> **Reaja** na mensagem do grupo com a letra do cargo que você quer. Para remover, é só **tirar a reação**. Pode marcar quantos quiser.

-# ⚠️ Mensagens enviadas neste canal são apagadas automaticamente após 48 horas.`,
      },
    ],
  };
}

/** @param {PingGroup} g */
function groupPayload(g) {
  const items = assign(g);
  const lines = items.map((it) => `${it.emoji} <@&${it.id}>`).join('\n');
  const desc = [g.note, lines].filter(Boolean).join('\n\n') || '—';
  return {
    ...SILENT,
    embeds: [{ title: g.title, color: COLOR, description: desc }],
  };
}

/**
 * Publica, reaproveita ou recria a mensagem de um stateId e devolve a mensagem.
 * Espelha `services/panels.js`, mas devolve o objeto (precisamos reagir nele).
 * @returns {Promise<import('discord.js').Message | null>}
 */
async function ensureMessage(channel, stateId, payload, label) {
  const state = collections.watcherState();
  const saved = await state.findOne({ _id: stateId });

  if (saved?.messageId && saved.channelId === channel.id) {
    const msg = await channel.messages.fetch(saved.messageId).catch(() => null);
    if (msg) {
      await msg.edit(payload).catch(() => {});
      return msg;
    }
  }

  const msg = await channel.send(payload);
  await state.updateOne(
    { _id: stateId },
    { $set: { messageId: msg.id, channelId: channel.id } },
    { upsert: true },
  );
  log.info(`Painel de ${label} publicado.`);
  return msg;
}

/** Garante que o bot reagiu com cada emoji, na ordem, sem duplicar. */
async function ensureReactions(msg, emojis) {
  for (const emoji of emojis) {
    const existing = msg.reactions.cache.get(emoji);
    if (existing?.me) continue;
    await msg.react(emoji).catch((e) => log.warn(`Falha ao reagir ${emoji}: ${e.message}`));
  }
}

/** Remove o painel único antigo, se ainda existir, para não deixar duplicata. */
async function removeLegacyPanel(channel) {
  const state = collections.watcherState();
  const doc = await state.findOne({ _id: LEGACY_STATE });
  if (!doc?.messageId) return;
  const msg = await channel.messages.fetch(doc.messageId).catch(() => null);
  if (msg) await msg.delete().catch(() => {});
  await state.deleteOne({ _id: LEGACY_STATE });
  log.info('Painel de pings antigo (mensagem única) removido.');
}

/**
 * Publica o cabeçalho e uma mensagem por grupo, reage nelas e reconstrói o mapa
 * letra→cargo. Chamado no boot e a cada ciclo de painéis.
 * @param {import('discord.js').Client} client
 * @param {string} guildDiscordId
 */
export async function ensurePingRolePanels(client, guildDiscordId) {
  const cfg = await getConfig(guildDiscordId);
  const channelId = cfg.channels?.pings;
  if (!channelId) return;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    log.warn('Canal de pings configurado mas inacessível.');
    return;
  }

  await removeLegacyPanel(channel);
  await ensureMessage(channel, HEADER_STATE, headerPayload(), 'pings (cabeçalho)');

  const nextMap = new Map();
  for (const g of PING_GROUPS) {
    const items = assign(g);
    if (!items.length) continue; // grupo só com slots vazios: nem publica
    const msg = await ensureMessage(channel, groupState(g.key), groupPayload(g), `pings (${g.key})`);
    if (!msg) continue;
    await ensureReactions(msg, items.map((it) => it.emoji));
    nextMap.set(msg.id, new Map(items.map((it) => [it.emoji, it.id])));
  }

  roleByMessage.clear();
  for (const [k, v] of nextMap) roleByMessage.set(k, v);
}

/** IDs das mensagens deste sistema, para a limpeza de 48h não apagá-las. */
export async function pingPanelMessageIds() {
  const docs = await collections
    .watcherState()
    .find({ _id: { $in: [...PING_STATE_IDS] } })
    .toArray();
  return new Set(docs.map((d) => d.messageId).filter(Boolean));
}

/**
 * @param {import('discord.js').MessageReaction | import('discord.js').PartialMessageReaction} reaction
 * @param {import('discord.js').User | import('discord.js').PartialUser} user
 * @param {boolean} add  true = ganhou o cargo; false = perdeu
 */
async function onReaction(reaction, user, add) {
  if (user.id === reaction.client.user.id) return; // ignora as reações do próprio bot

  if (reaction.partial) {
    if (!(await reaction.fetch().then(() => true).catch(() => false))) return;
  }

  const map = roleByMessage.get(reaction.message.id);
  if (!map) return;
  const roleId = map.get(reaction.emoji.name);
  if (!roleId) return;

  const guild = reaction.message.guild;
  if (!guild) return;
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return;

  try {
    if (add) await member.roles.add(roleId);
    else await member.roles.remove(roleId);
  } catch (e) {
    log.warn(`Reaction-role (${add ? 'add' : 'remove'}) cargo ${roleId}: ${e.message}`);
  }
}

/** Liga os listeners de reação. Chamar uma vez, no clientReady. */
export function attachPingRoleHandler(client) {
  client.on('messageReactionAdd', (r, u) => {
    onReaction(r, u, true).catch((e) => log.error('messageReactionAdd:', e));
  });
  client.on('messageReactionRemove', (r, u) => {
    onReaction(r, u, false).catch((e) => log.error('messageReactionRemove:', e));
  });
}
