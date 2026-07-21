import { readFileSync } from 'node:fs';
import { wynn } from '../wynn/api.js';
import { collections } from '../db/mongo.js';
import { getConfig } from '../config/guildConfig.js';
import { optional } from '../config/env.js';
import { shortNumber, membersLimit, calcExperience, getByPath, diffPaths } from '../util/format.js';
import { xpBarEmoji } from '../util/emojis.js';
import { captureValue, recordCapture } from './territories.js';
import { recordEvent, eventPoints } from './points.js';
import { logoAttachment, brandWithLogo } from '../util/assets.js';
import { log } from '../util/log.js';

const territoryMap = JSON.parse(
  readFileSync(new URL('../data/territoryMap.json', import.meta.url), 'utf8'),
);

const RANKS = ['owner', 'chief', 'strategist', 'captain', 'recruiter', 'recruit'];
const ROLE_LABEL = {
  owner: '[Líder]',
  chief: '[Sub-líder]',
  strategist: '[Estrategista]',
  captain: '[Capitão]',
  recruiter: '[Recrutador]',
  recruit: '[Recruta]',
};
const iso = () => new Date().toISOString();

// Estado anterior em memória. Ao reiniciar, o primeiro poll vira baseline
// (sem spam de mudanças). O ID da mensagem do painel é persistido no Mongo.
let prevGuild = null;
let prevTerritory = null;

// A API não diz quem capturou um território. O contador de guerras de cada
// membro subir é a melhor aproximação disponível: quem "guerreou" nos últimos
// minutos entra no rateio da captura. A janela cobre o descompasso entre o
// incremento do contador e a troca de dono do território.
const WAR_WINDOW_MS = 5 * 60_000;
const recentWarriors = new Map(); // uuid -> { username, at }

function membersByUuid(guild) {
  const out = new Map();
  for (const rank of RANKS) {
    for (const [username, m] of Object.entries(guild.members[rank] || {})) {
      out.set(m.uuid, { username, wars: Number(m.globalData?.wars ?? 0) });
    }
  }
  return out;
}

function trackWarParticipants(prev, curr) {
  const now = Date.now();
  for (const [uuid, v] of recentWarriors) {
    if (now - v.at > WAR_WINDOW_MS) recentWarriors.delete(uuid);
  }
  if (!prev) return; // primeiro poll: só baseline
  const before = membersByUuid(prev);
  for (const [uuid, m] of membersByUuid(curr)) {
    const old = before.get(uuid);
    if (old && m.wars > old.wars) recentWarriors.set(uuid, { username: m.username, at: now });
  }
}

// currentGuildRaids.list traz a contagem por raid de cada membro. Quem subiu a
// contagem da mesma raid, no mesmo poll e no mesmo mundo, estava no mesmo grupo.
function guildRaidCounts(guild) {
  const out = new Map();
  for (const rank of RANKS) {
    for (const [username, m] of Object.entries(guild.members[rank] || {})) {
      out.set(m.uuid, {
        username,
        server: m.server || null,
        list: m.globalData?.currentGuildRaids?.list || {},
      });
    }
  }
  return out;
}

export function detectGuildRaids(prev, curr) {
  if (!prev) return [];
  const before = guildRaidCounts(prev);
  const parties = new Map();

  for (const [uuid, m] of guildRaidCounts(curr)) {
    const old = before.get(uuid);
    if (!old) continue;
    for (const [raid, count] of Object.entries(m.list)) {
      if (Number(count) <= Number(old.list[raid] ?? 0)) continue;

      // O mundo separa dois grupos que terminaram a mesma raid no mesmo poll.
      // Sem mundo conhecido (deslogou logo depois), o jogador vira um grupo só
      // dele — melhor um embed a menos do que juntá-lo ao grupo de outros.
      const server = m.server || old.server;
      const key = server ? `${raid}\u0000${server}` : `${raid}\u0000${uuid}`;

      if (!parties.has(key)) parties.set(key, { raid, server, members: [] });
      parties.get(key).members.push(m.username);
    }
  }
  return [...parties.values()];
}

// Objetivo semanal: a API (autenticada) só diz se o desta semana está feito.
// Anunciamos a virada de "não fez" para "fez". Sem WYNN_API_KEY o campo é
// indefinido para todos, e nada é anunciado.
export function detectWeeklyCompletions(prev, curr) {
  if (!prev) return [];
  const before = new Map();
  for (const rank of RANKS) {
    for (const m of Object.values(prev.members[rank] || {})) {
      before.set(m.uuid, m.weekly?.completed);
    }
  }

  const done = [];
  for (const rank of RANKS) {
    for (const [username, m] of Object.entries(curr.members[rank] || {})) {
      if (m.weekly?.completed === true && before.get(m.uuid) === false) {
        done.push({ username, streak: Number(m.weekly.streak ?? 0) });
      }
    }
  }
  return done;
}

async function announceWeekly(client, cfg, guild, done) {
  const channel = await fetchChannel(client, cfg.channels?.raids ?? cfg.channels?.activity);
  if (!channel) return;

  for (const { username, streak } of done) {
    await channel.send({ embeds: [{
      title: '📅 Objetivo semanal concluído',
      description: `**${username}** completou o objetivo da semana.${streak > 1 ? `\n🔥 Sequência de **${streak}** semanas.` : ''}`,
      color: 0x1abc9c,
      thumbnail: { url: `https://visage.surgeplay.com/bust/350/${username}` },
      footer: { text: `${guild.name} [${guild.prefix}]` },
      timestamp: iso(),
    }] }).catch(() => {});
  }
}

async function announceGuildRaids(client, cfg, guild, raids) {
  // Canal próprio, se houver. Senão cai no de atividade — mas aí o anúncio some
  // no meio do vai-e-vem de online/offline.
  const channel = await fetchChannel(client, cfg.channels?.raids ?? cfg.channels?.activity);
  if (!channel) return;

  for (const { raid, server, members } of raids) {
    const roster = members.map((n, i) => `\`${i + 1}.\` ${n}`).join('\n');
    await channel.send({ embeds: [{
      title: raid,
      description: `**⚔️ Guild Raid concluída**\n\n${roster}`,
      color: 0x9b59b6,
      thumbnail: { url: `https://visage.surgeplay.com/bust/350/${members[0]}` },
      footer: { text: `${guild.name} [${guild.prefix}]${server ? ` — ${server}` : ''}` },
      timestamp: iso(),
    }] }).catch(() => {});
  }
}

export async function runGuildWatch(client) {
  const guildDiscordId = optional('DISCORD_GUILD_ID');
  const prefix = optional('WYNN_GUILD_PREFIX');
  if (!guildDiscordId || !prefix) return;
  const cfg = await getConfig(guildDiscordId);

  const guild = await wynn.guildByPrefix(prefix, { fresh: true }).catch(() => null);
  if (guild && guild.members) {
    if (prevGuild) {
      const changes = diffPaths(prevGuild, guild);
      if (changes.length) await handleGuildChanges(client, cfg, guild, prevGuild, changes);
    }
    trackWarParticipants(prevGuild, guild);
    const raids = detectGuildRaids(prevGuild, guild);
    if (raids.length) await announceGuildRaids(client, cfg, guild, raids);
    const weekly = detectWeeklyCompletions(prevGuild, guild);
    if (weekly.length) await announceWeekly(client, cfg, guild, weekly);
    await updatePanel(client, cfg, guild);
    prevGuild = guild;
  }

  const terr = await wynn.territoryList({ fresh: true }).catch(() => null);
  if (terr && typeof terr === 'object') {
    if (prevTerritory) {
      const changes = diffPaths(prevTerritory, terr);
      if (changes.length) await handleTerritoryChanges(client, cfg, prefix, terr, prevTerritory, changes);
    }
    prevTerritory = terr;
  }
}

function fetchChannel(client, id) {
  if (!id) return Promise.resolve(null);
  return client.channels.fetch(id).catch(() => null);
}

function buildPanel(client, guild) {
  const online = [];
  for (const rank of RANKS) {
    const group = guild.members[rank] || {};
    for (const [username, m] of Object.entries(group)) {
      if (m.online) online.push({ username, role: rank, server: m.server || '?' });
    }
  }
  const reqXp = calcExperience(guild.level);
  const currXp = (reqXp / 100) * (Number(guild.xpPercent) || 0);
  let list = online.map((p) => `${ROLE_LABEL[p.role]} ${p.username} — ${p.server}`).join('\n');
  if (list.length > 3500) list = `${list.slice(0, 3500)}\n…`;
  if (!list) list = 'Ninguém online';

  return brandWithLogo({
    embeds: [
      {
        title: `${guild.name} [${guild.prefix}]`,
        color: 0x2ecc71,
        description:
`**🎉 Nível:** \`${guild.level} (${guild.xpPercent}%)\` — \`${shortNumber(Math.floor(currXp))}/${shortNumber(Math.floor(reqXp))}\`
${xpBarEmoji(guild.xpPercent)}
**🚧 Territórios:** \`${guild.territories}\`
**🏹 Guerras:** \`${guild.wars}\`
**🤙 Membros:** \`${guild.members.total}/${membersLimit(guild.level)}\`

**Online (${online.length}/${guild.members.total}):**
${list}

-# Atualizado <t:${Math.floor(Date.now() / 1000)}:R>`,
        footer: { text: 'WnBR — Informações', iconURL: client.user.displayAvatarURL() },
      },
    ],
    // Sem botões: skin, capa e modpack agora vivem no painel de downloads.
    // `[]` (e não omitir) para LIMPAR os botões antigos ao editar no lugar.
    components: [],
  });
}

async function updatePanel(client, cfg, guild) {
  const channel = await fetchChannel(client, cfg.channels?.panel);
  if (!channel) return;
  const payload = buildPanel(client, guild);
  const state = collections.watcherState();
  const saved = await state.findOne({ _id: 'panel' });
  if (saved?.messageId) {
    const msg = await channel.messages.fetch(saved.messageId).catch(() => null);
    if (msg) {
      // SEMPRE edita no lugar — nunca reenvia (o painel perderia a posição no
      // canal). Se a mensagem ainda não tem o logo, anexamos NESTA edição; as
      // seguintes omitem o arquivo e o Discord preserva o anexo.
      const needsFiles = msg.attachments.size === 0;
      await msg.edit(needsFiles ? { ...payload, files: [logoAttachment()] } : payload).catch(() => {});
      return;
    }
  }
  const msg = await channel.send({ ...payload, files: [logoAttachment()] });
  await state.updateOne(
    { _id: 'panel' },
    { $set: { messageId: msg.id, channelId: channel.id } },
    { upsert: true },
  );
}

async function handleGuildChanges(client, cfg, guild, old, changes) {
  const channel = await fetchChannel(client, cfg.channels?.activity);
  if (!channel) return;
  const presence = cfg.params?.announcePresence !== false;
  const seen = new Set();

  for (const path of changes) {
    if (!presence && (path.endsWith('/online') || path.endsWith('/server'))) continue;

    if (path.endsWith('/online') && typeof getByPath(guild, path) === 'boolean') {
      const player = path.split('/').slice(-2, -1)[0];
      if (seen.has(player)) continue;
      seen.add(player);
      const online = getByPath(guild, path);
      const server = getByPath(guild, path.replace(/\/online$/, '/server'));
      await channel.send({ embeds: [{
        title: '🕹️ Status do Jogador',
        description: `**Jogador:** \`${player}\`\n**Status:** ${online ? `Online no servidor \`${server}\`` : 'Offline'}`,
        color: online ? 0x00ff00 : 0xff0000,
        thumbnail: { url: `https://visage.surgeplay.com/bust/350/${player}` },
        timestamp: iso(),
      }] }).catch(() => {});
    } else if (path.endsWith('/server')) {
      const player = path.split('/').slice(-2, -1)[0];
      if (seen.has(player)) continue;
      const oldS = getByPath(old, path);
      const newS = getByPath(guild, path);
      if (!oldS || !newS) continue;
      await channel.send({ embeds: [{
        title: '🔄 Mudança de Servidor',
        description: `**Jogador:** \`${player}\`\n> \`${oldS}\` → \`${newS}\``,
        color: 0xffff00,
        timestamp: iso(),
      }] }).catch(() => {});
    } else if (path === '/xpPercent') {
      await channel.send({ embeds: [{
        title: '📊 Mudança na Porcentagem de XP',
        description: `${xpBarEmoji(getByPath(guild, path))}\n\`${getByPath(old, path)}%\` → \`${getByPath(guild, path)}%\``,
        color: 0x3498db,
        timestamp: iso(),
      }] }).catch(() => {});
    } else if (path === '/territories') {
      await channel.send({ embeds: [{ title: '🗺️ Mudança no Número de Territórios', description: `\`${getByPath(old, path)}\` → \`${getByPath(guild, path)}\``, color: 0x00ff00, timestamp: iso() }] }).catch(() => {});
    } else if (path === '/wars') {
      await channel.send({ embeds: [{ title: '⚔️ Mudança no Número de Guerras', description: `\`${getByPath(old, path)}\` → \`${getByPath(guild, path)}\``, color: 0xff4500, timestamp: iso() }] }).catch(() => {});
    } else if (path === '/level') {
      await channel.send({ embeds: [{ title: '🏆 Mudança no Nível da Guilda', description: `\`${getByPath(old, path)}\` → \`${getByPath(guild, path)}\``, color: 0xffd700, timestamp: iso() }] }).catch(() => {});
    } else if (path.startsWith('/seasonRanks/')) {
      const rankId = path.split('/')[2];
      await channel.send({ embeds: [{ title: '🌟 Mudança na Pontuação de Season', description: `**Season:** \`${rankId}\`\n\`${getByPath(old, path)}\` → \`${getByPath(guild, path)}\``, color: 0xff69b4, timestamp: iso() }] }).catch(() => {});
    }
  }
}

async function handleTerritoryChanges(client, cfg, prefix, terr, prevT, changes) {
  const terrChannel = await fetchChannel(client, cfg.channels?.territory);
  const warChannel = await fetchChannel(client, cfg.channels?.war);

  const changed = new Set(changes.map((p) => p.split('/')[1]).filter(Boolean));
  const ourCount = Object.values(terr).filter((t) => t?.guild?.prefix === prefix).length;

  for (const name of changed) {
    const now = terr[name];
    const before = prevT[name];
    const newOwner = now?.guild?.prefix;
    const oldOwner = before?.guild?.prefix;
    if (newOwner === oldOwner) continue;
    const gained = newOwner === prefix;
    const lost = oldOwner === prefix;
    if (!gained && !lost) continue; // só nos interessa quando envolve a nossa guilda

    // O valor sai do estado ANTERIOR: é lá que o defensor ainda é dono e as
    // fronteiras dele ainda contam.
    const value = gained ? await scoreCapture(cfg, prevT, name) : null;

    const info = territoryMap[name]?.resources || {};
    const embed = {
      title: '🗺️ Atualização de Território',
      description:
`**Território:** \`${name}\`
**Novo Dono:** \`[${newOwner ?? '-'}] ${now?.guild?.name ?? 'Nenhum'}\`
**Antigo Dono:** \`[${oldOwner ?? '-'}] ${before?.guild?.name ?? 'Nenhum'}\`
- Esmeraldas: \`x${info.emeralds ?? 0}/h\`
- Minérios: \`x${info.ore ?? 0}/h\`
- Colheita: \`x${info.crops ?? 0}/h\`
- Peixe: \`x${info.fish ?? 0}/h\`
- Madeira: \`x${info.wood ?? 0}/h\`
${value ? `\n${captureSummary(value)}` : ''}
> Temos agora \`${ourCount}\` territórios.`,
      color: gained ? 0x00ff00 : 0xff0000,
      timestamp: iso(),
    };

    const alerta = `${lost ? '🚨 **Perdemos**' : '🟢 **Conquistamos**'} o território \`${name}\`!`;

    // Quando war e territory apontam para o mesmo canal, o aviso e o detalhe
    // viram UMA mensagem só — senão o canal recebe a mesma captura duas vezes.
    if (terrChannel && warChannel && terrChannel.id === warChannel.id) {
      await warChannel
        .send({ content: alerta, embeds: [embed] })
        .catch(() => {});
      continue;
    }

    if (terrChannel) await terrChannel.send({ embeds: [embed] }).catch(() => {});
    if (warChannel) {
      const who = value?.participants.length
        ? value.participants.map((p) => p.username).join(', ')
        : 'nenhum guerreiro detectado';
      const bonus = value ? ` — dificuldade \`x${value.multiplier.toFixed(2)}\`, vale \`~${value.points}\` pts para ${who}` : '';
      await warChannel.send({ content: `${alerta}${bonus}` }).catch(() => {});
    }
  }
}

function captureSummary(v) {
  const lines = [
    `**Fronteiras aliadas do defensor:** \`${v.connections}\` → multiplicador \`x${v.multiplier.toFixed(2)}\``,
  ];
  if (v.isHq) lines.push(`**Era o QG de [${v.defender}]** — \`${v.externals}\` externals`);
  if (v.defences) lines.push(`**Defesa:** \`${v.defences}\``);
  lines.push(warriorsLine(v));
  if (v.capped) lines.push('-# Multiplicador limitado pelo teto configurado.');
  lines.push('-# Os pontos entram no ranking na apuração diária.');
  return `${lines.join('\n')}\n`;
}

// Cada guerreiro do rateio ganha o mesmo `points`. Mostramos os nomes em vez de
// só a contagem para o pessoal ver quem pontuou. Sem participantes, deixamos
// explícito que a janela não pegou ninguém (a API não diz quem capturou).
function warriorsLine(v) {
  const names = v.participants.map((p) => `\`${p.username}\``);
  if (!names.length) return `**Vale:** \`~${v.points}\` pts — nenhum guerreiro detectado na janela`;
  return `**Vale:** \`~${v.points}\` pts para cada: ${names.join(', ')}`;
}

// Registra a captura como evento com o multiplicador CRU. O valor em pontos é
// derivado depois, no recompute diário — aqui só mostramos uma prévia com os
// pesos vigentes.
async function scoreCapture(cfg, prevT, name) {
  const raw = captureValue(prevT, name);
  const participants = [...recentWarriors.entries()].map(([uuid, v]) => ({
    uuid,
    username: v.username,
  }));

  const params = cfg.params || {};
  const cap = Number(params.territoryMultiplierCap) || Infinity;

  // O evento de território paga só o excedente; a base vem da guerra. Somamos as
  // duas para mostrar ao guerreiro o que a captura vale de verdade.
  const bonus = eventPoints({ type: 'territory', qty: raw.multiplier }, params);
  const base = Number(params.pointsWeights?.war) || 0;

  const value = {
    ...raw,
    capped: raw.multiplier > cap,
    points: Math.round(base + bonus),
    participants,
  };

  try {
    await recordCapture({
      territory: name,
      defender: raw.defender,
      isHq: raw.isHq,
      connections: raw.connections,
      externals: raw.externals,
      multiplier: raw.multiplier,
      participants,
    });
    const meta = { territory: name, defender: raw.defender, isHq: raw.isHq, connections: raw.connections };
    for (const p of participants) {
      await recordEvent({ uuid: p.uuid, username: p.username, type: 'territory', qty: raw.multiplier, meta });
    }
  } catch (e) {
    log.error('Falha ao registrar captura de território:', e);
  }
  return value;
}
