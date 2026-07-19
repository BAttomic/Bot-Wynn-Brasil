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
 * Cada cargo é identificado por `id` OU por `name`. Com `name`, o bot resolve o
 * cargo pelo nome na guilda a cada boot — e o CRIA se ainda não existir. É assim
 * que um ping novo entra sem ninguém precisar copiar id de cargo: basta o nome.
 * Um slot que não resolve para cargo nenhum é omitido (não consome letra).
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
 * @property {string} [id]   id do cargo (tem prioridade sobre o nome)
 * @property {string} [name] nome do cargo; resolvido/criado na guilda quando não há id
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
      { name: 'PING GUILD XP' },
      { id: '1268213746585698375' }, // Lutho Witness Church (100+)
      { id: '1268211113942847603' }, // Corkus Scrapyard (85+)
      { id: '1268209833090486423' }, // Cinfras Waterfall (75-85)
      { id: '1268209831219560560' }, // Geliboard Visceral Cave (65-75)
      { id: '1268209827457400844' }, // Troms Idol Cave (60-75)
      { id: '1268208726058205245' }, // Troms Herb Cave (50-65)
      { id: '1268208320452235306' }, // Almuj Desert Altar (35-50)
      { id: '1268208320343445516' }, // Nemract Saint's Row (20-35)
      { name: 'PING XP - Fruma Lighthouse (115+)' },
      { name: 'PING XP - Fruma BatCave (107+)' },
    ],
  },
  {
    key: 'dungeon',
    title: '2. Pings de Dungeon',
    roles: [
      { id: '1268218114999586816' }, // The Forgery (98+)
      { id: '1268218115402109049' }, // Eldritch Outlook (101+)
      { id: '1268218120196325517' }, // Fallen Factory (90+)
      { id: '1268218114043019425' }, // Galleon's Graveyard (63+)
      { id: '1268220280166420572' }, // Undergrowth Ruins (54+)
      { id: '1268220287510384653' }, // Ice Barrows (45+)
      { id: '1268220291788574814' }, // Sand-Swept Tomb (36+)
      { id: '1268218121324462226' }, // Timelost Sanctum (27+)
      { id: '1268218113137311877' }, // Underworld Crypt (24+)
      { id: '1268218101682405396' }, // Infested Pit (18+)
      { id: '1268218112319291462' }, // Decrepit Sewers (9+)
    ],
  },
  {
    key: 'prof',
    title: '3. Pings de Profissões',
    note: 'Peça para alguém coletar um recurso ou craftar um item para você.',
    roles: [
      { id: '1331682928979218462' }, // Farming
      { id: '1331682931940528188' }, // Fishing
      { id: '1331682925401473095' }, // Mining
      { id: '1331682920431226892' }, // Woodcutting
      { id: '1331682933265793096' }, // Alchemism
      { id: '1331682936629497907' }, // Armouring
      { id: '1331682933655867472' }, // Cooking
      { id: '1331682934901444649' }, // Jeweling
      { id: '1331682934259978445' }, // Scribing
      { id: '1331682935937564692' }, // Tailoring
      { id: '1331682935627190283' }, // Weaponsmith
      { id: '1331682937309102191' }, // Woodworking
    ],
  },
  {
    key: 'raids',
    title: '4. Pings de Quests e Raids',
    note: 'Convide outros membros para participar com você.',
    roles: [
      { id: '1271168738002997279' }, // QUEST - Qira's Hive (80+)
      { id: '1269810703972171908' }, // QUEST - ??? (80+)
      { id: '1269810688352718918' }, // QUEST - Tower of Ascension (75+)
      { name: 'PING RAID - The Wartorn Palace (119+)' },
      { id: '1268229834455253013' }, // RAID - The Nameless Anomaly (103+)
      { id: '1268229845398327417' }, // RAID - The Canyon Colossus (95+)
      { id: '1268229846144647170' }, // RAID - Orphion's Nexus of Light (79+)
      { id: '1268229847075786853' }, // RAID - Nest of the Grootslangs (54+)
    ],
  },
  {
    key: 'classes',
    title: '5. Pings de Classes',
    note: 'Encontre jogadores da mesma classe.',
    roles: [
      { id: '1269826644693221466' }, // Archer 120+
      { id: '1269826646886584413' }, // Assassin 120+
      { id: '1269826649386385520' }, // Mage 120+
      { id: '1269826651878068374' }, // Shaman 120+
      { id: '1269826654381805669' }, // Warrior 120+
    ],
  },
  {
    key: 'events',
    title: '6. Pings de Eventos',
    note: 'Fique por dentro dos eventos.',
    roles: [
      { id: '1273252381018165308' }, // WORLD EVENT - Annihilation
      { id: '1295760021375815701' }, // EVENT
    ],
  },
  {
    key: 'bombs',
    title: '7. Pings de Bombas',
    note: 'Jogadores com rank Champion conseguem ver as bombas ativas, pingue-os e pergunte quais tem ativas.',
    roles: [
      { name: 'PING BOMBS - Champion' },
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
 * Resolve um slot para o id de um cargo real: usa o `id` se houver, senão procura
 * pelo `name` na guilda e, não achando, cria o cargo. `null` se não der.
 * @param {import('discord.js').Guild} guild
 * @param {PingRole} slot
 * @returns {Promise<string | null>}
 */
async function resolveRoleId(guild, slot) {
  if (slot.id) return slot.id;
  if (!slot.name) return null;

  const existing = guild.roles.cache.find((r) => r.name === slot.name);
  if (existing) return existing.id;

  try {
    const created = await guild.roles.create({
      name: slot.name,
      mentionable: true,
      reason: 'Cargo de ping criado automaticamente pelo bot',
    });
    log.info(`Cargo de ping criado: "${slot.name}" (${created.id}).`);
    return created.id;
  } catch (e) {
    log.warn(`Não consegui criar o cargo de ping "${slot.name}": ${e.message}`);
    return null;
  }
}

/**
 * Cargos resolvidos de um grupo, na ordem, com a letra de cada um. Slots que não
 * resolvem são pulados, então as letras ficam sempre contíguas.
 * @param {import('discord.js').Guild} guild
 * @param {PingGroup} g
 * @returns {Promise<Array<{id: string, emoji: string}>>}
 */
async function assign(guild, g) {
  const out = [];
  for (const slot of g.roles) {
    if (out.length >= LETTERS.length) break;
    const id = await resolveRoleId(guild, slot);
    if (id) out.push({ id, emoji: LETTERS[out.length] });
  }
  return out;
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

/**
 * @param {PingGroup} g
 * @param {Array<{id: string, emoji: string}>} items  cargos já resolvidos
 */
function groupPayload(g, items) {
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

/**
 * Reconcilia as reações da mensagem com a lista desejada: adiciona as que faltam
 * (na ordem) e remove as letras que o bot pôs e não valem mais — é o que evita
 * uma letra órfã quando um grupo encolhe (ex.: Classes de 7 para 5 cargos).
 */
async function ensureReactions(msg, emojis) {
  const want = new Set(emojis);

  for (const emoji of emojis) {
    const existing = msg.reactions.cache.get(emoji);
    if (existing?.me) continue;
    await msg.react(emoji).catch((e) => log.warn(`Falha ao reagir ${emoji}: ${e.message}`));
  }

  for (const reaction of msg.reactions.cache.values()) {
    const name = reaction.emoji.name;
    // Só mexe nas letras que ESTE sistema usa, e só nas que o próprio bot pôs.
    if (want.has(name) || !LETTERS.includes(name) || !reaction.me) continue;
    // reaction.remove() limpa a letra inteira (precisa de Gerenciar Mensagens);
    // sem essa permissão, ao menos tira a reação do bot.
    await reaction
      .remove()
      .catch(() => reaction.users.remove(msg.client.user.id).catch(() => {}));
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

  // Resolver/criar cargos por nome precisa do cache de cargos populado.
  const guild = channel.guild;
  await guild.roles.fetch().catch(() => {});

  await removeLegacyPanel(channel);
  await ensureMessage(channel, HEADER_STATE, headerPayload(), 'pings (cabeçalho)');

  const nextMap = new Map();
  for (const g of PING_GROUPS) {
    const items = await assign(guild, g);
    if (!items.length) continue; // grupo sem nenhum cargo resolvido: nem publica
    const msg = await ensureMessage(channel, groupState(g.key), groupPayload(g, items), `pings (${g.key})`);
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
