import { wynn } from '../wynn/api.js';
import { collections } from '../db/mongo.js';
import { getConfig } from '../config/guildConfig.js';
import { optional } from '../config/env.js';
import { shortNumber, membersLimit, calcExperience, getByPath, diffPaths } from '../util/format.js';
import { xpBarEmoji, EMOJI } from '../util/emojis.js';
import { captureValue, recordCapture } from './territories.js';
import { recordEvent, eventPoints, recordWeeklyCompletion } from './points.js';
import { communityRow } from './leaderboardPanel.js';
import { logoAttachment, brandWithLogo } from '../util/assets.js';
import { log } from '../util/log.js';

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
// membro subir é a melhor aproximação disponível. Mas o endpoint de guilda é
// MUITO cacheado: quando o território troca de dono (endpoint quase em tempo
// real), o contador de guerra do membro ainda não subiu. Por isso a atribuição
// não é feita na hora — é feita no flush horário, quando o contador já alcançou.
//
// Guardamos um LOG de incrementos de guerra com horário, e no flush cada captura
// leva os guerreiros cujo incremento caiu perto do horário dela.
const WAR_LOG_RETENTION_MS = 90 * 60_000; // cobre o buffer de 1h + folga do cache
const ATTRIB_WINDOW_MS = 15 * 60_000; // guerra ±15min da captura conta para ela
const FLUSH_GRACE_MS = 6 * 60_000; // idade mínima da captura antes de anunciar
const warriorLog = []; // { uuid, username, at } — em ordem cronológica

// Capturas/perdas acumuladas, soltas em UM aviso agrupado por hora (anti-spam).
const pendingTerritory = []; // { name, gained, lost, newOwner, oldOwner, ...names, value, at }
// Começa "cheio" para o primeiro resumo só sair um intervalo depois do boot.
let lastDigestAt = Date.now();

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
  // Poda o log pela frente (sempre inserido em ordem cronológica).
  while (warriorLog.length && now - warriorLog[0].at > WAR_LOG_RETENTION_MS) warriorLog.shift();
  if (!prev) return; // primeiro poll: só baseline
  const before = membersByUuid(prev);
  for (const [uuid, m] of membersByUuid(curr)) {
    const old = before.get(uuid);
    if (old && m.wars > old.wars) warriorLog.push({ uuid, username: m.username, at: now });
  }
}

// Guerreiros cujo contador subiu perto do horário da captura. Dedup por uuid.
function attributeWarriors(capAt) {
  const seen = new Map();
  for (const w of warriorLog) {
    if (Math.abs(w.at - capAt) <= ATTRIB_WINDOW_MS) seen.set(w.uuid, w.username);
  }
  return [...seen].map(([uuid, username]) => ({ uuid, username }));
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
        done.push({ uuid: m.uuid, username, streak: Number(m.weekly.streak ?? 0) });
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
      description: `**:crossed_swords: Guild Raid concluída**\n\n${roster}`,
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
    if (weekly.length) {
      // Pontuar vem primeiro e não depende de canal configurado: o anúncio é
      // enfeite, o evento é o que conta.
      for (const w of weekly) {
        await recordWeeklyCompletion({ uuid: w.uuid, username: w.username, streak: w.streak });
      }
      await announceWeekly(client, cfg, guild, weekly);
    }
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
**${EMOJI.war} Guerras:** \`${guild.wars}\`
**🤙 Membros:** \`${guild.members.total}/${membersLimit(guild.level)}\`

**Online (${online.length}/${guild.members.total}):**
${list}

-# Atualizado <t:${Math.floor(Date.now() / 1000)}:R>`,
        footer: { text: 'WnBR — Informações', iconURL: client.user.displayAvatarURL() },
      },
    ],
    // Skin, capa e modpack vivem no painel de downloads; aqui fica só o WhatsApp.
    components: [communityRow()],
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
      await channel.send({ embeds: [{ title: ':crossed_swords: Mudança no Número de Guerras', description: `\`${getByPath(old, path)}\` → \`${getByPath(guild, path)}\``, color: 0xff4500, timestamp: iso() }] }).catch(() => {});
    } else if (path === '/level') {
      await channel.send({ embeds: [{ title: '🏆 Mudança no Nível da Guilda', description: `\`${getByPath(old, path)}\` → \`${getByPath(guild, path)}\``, color: 0xffd700, timestamp: iso() }] }).catch(() => {});
    } else if (path.startsWith('/seasonRanks/')) {
      const rankId = path.split('/')[2];
      await channel.send({ embeds: [{ title: '🌟 Mudança na Pontuação de Season', description: `**Season:** \`${rankId}\`\n\`${getByPath(old, path)}\` → \`${getByPath(guild, path)}\``, color: 0xff69b4, timestamp: iso() }] }).catch(() => {});
    }
  }
}

// Não anuncia nem pontua na hora: só EMPILHA a captura/perda no buffer. O valor
// (multiplicador cru) sai do estado ANTERIOR, onde o defensor ainda é dono e as
// fronteiras dele ainda contam. Participantes e pontos são resolvidos no flush.
function handleTerritoryChanges(client, cfg, prefix, terr, prevT, changes) {
  const changed = new Set(changes.map((p) => p.split('/')[1]).filter(Boolean));
  const now = Date.now();

  for (const name of changed) {
    const nowT = terr[name];
    const before = prevT[name];
    const newOwner = nowT?.guild?.prefix;
    const oldOwner = before?.guild?.prefix;
    if (newOwner === oldOwner) continue;
    const gained = newOwner === prefix;
    const lost = oldOwner === prefix;
    if (!gained && !lost) continue; // só nos interessa quando envolve a nossa guilda

    pendingTerritory.push({
      name,
      gained,
      lost,
      newOwner: newOwner ?? null,
      newName: nowT?.guild?.name ?? null,
      oldOwner: oldOwner ?? null,
      oldName: before?.guild?.name ?? null,
      value: gained ? captureValue(prevT, name) : null,
      at: now,
    });
  }
}

function truncate(s, max = 1000) {
  return s.length > max ? `${s.slice(0, max)} …` : s;
}

// Monta o único aviso agrupado do intervalo.
function digestPayload({ gains, losses, warriorCaps, totalPoints, ourCount, minutes }) {
  const capLine = (c) => (c.multiplier > 1 ? `${c.name} \`x${c.multiplier.toFixed(2)}\`` : c.name);
  const fields = [];
  if (gains.length) {
    fields.push({ name: `🟢 Conquistados (${gains.length})`, value: truncate(gains.map(capLine).join(', ')) });
  }
  if (losses.length) {
    fields.push({ name: `🚨 Perdidos (${losses.length})`, value: truncate(losses.map((c) => c.name).join(', ')) });
  }
  const warriors = [...warriorCaps.entries()].sort((a, b) => b[1] - a[1]);
  fields.push({
    name: ':crossed_swords: Guerreiros',
    value: warriors.length
      ? truncate(warriors.map(([n, c]) => `**${n}** — ${c} captura${c > 1 ? 's' : ''}`).join('\n'))
      : 'Nenhum guerreiro detectado na janela.',
  });

  return {
    embeds: [
      {
        title: '🗺️ Guerra de Território — resumo',
        color: 0x2ecc71,
        description:
`Temos agora \`${ourCount}\` territórios.${totalPoints ? `\nDistribuídos \`~${totalPoints}\` pts entre os guerreiros (entram na apuração diária).` : ''}`,
        fields,
        footer: { text: `Agrupado para evitar spam — no máx. 1 aviso a cada ${minutes} min.` },
        timestamp: iso(),
      },
    ],
    allowedMentions: { parse: [] },
  };
}

// Solta UM aviso agrupado por intervalo (padrão 60 min). Como espera, o contador
// de guerra — cacheado — já subiu, e a atribuição de guerreiros fica correta.
// Chamado por um job frequente; ele mesmo decide se já é hora.
export async function flushTerritoryDigest(client) {
  const guildDiscordId = optional('DISCORD_GUILD_ID');
  const prefix = optional('WYNN_GUILD_PREFIX');
  if (!guildDiscordId || !prefix || !pendingTerritory.length) return;

  const cfg = await getConfig(guildDiscordId);
  const minutes = Number(cfg.params?.territoryDigestMinutes) || 60;
  const intervalMs = minutes * 60_000;
  const now = Date.now();
  if (now - lastDigestAt < intervalMs) return; // no máximo um por intervalo

  // Só solta capturas com uma idade mínima, para dar tempo do contador alcançar.
  const grace = Math.min(FLUSH_GRACE_MS, intervalMs);
  const ready = pendingTerritory.filter((c) => now - c.at >= grace);
  if (!ready.length) return;

  // Tira os prontos do buffer; os muito recentes ficam para o próximo ciclo.
  for (const c of ready) {
    const i = pendingTerritory.indexOf(c);
    if (i >= 0) pendingTerritory.splice(i, 1);
  }
  lastDigestAt = now;

  const params = cfg.params || {};
  const base = Number(params.pointsWeights?.war) || 0;
  const gains = [];
  const losses = [];
  const warriorCaps = new Map(); // username -> nº de capturas
  let totalPoints = 0;

  for (const c of ready) {
    if (c.lost) {
      losses.push(c);
      continue;
    }
    const raw = c.value || { multiplier: 1 };
    const participants = attributeWarriors(c.at);
    // O evento de território paga só o excedente; a base vem da guerra.
    const bonus = eventPoints({ type: 'territory', qty: raw.multiplier }, params);
    const points = Math.round(base + bonus);
    totalPoints += points * participants.length;
    for (const p of participants) warriorCaps.set(p.username, (warriorCaps.get(p.username) || 0) + 1);
    gains.push({ name: c.name, multiplier: raw.multiplier });

    try {
      await recordCapture({
        territory: c.name,
        defender: raw.defender ?? null,
        isHq: !!raw.isHq,
        connections: raw.connections ?? 0,
        externals: raw.externals ?? 0,
        multiplier: raw.multiplier,
        participants,
      });
      const meta = { territory: c.name, defender: raw.defender ?? null, isHq: !!raw.isHq, connections: raw.connections ?? 0 };
      for (const p of participants) {
        await recordEvent({ uuid: p.uuid, username: p.username, type: 'territory', qty: raw.multiplier, meta });
      }
    } catch (e) {
      log.error('Falha ao registrar captura de território:', e);
    }
  }

  const ourCount = Object.values(prevTerritory || {}).filter((t) => t?.guild?.prefix === prefix).length;
  const payload = digestPayload({ gains, losses, warriorCaps, totalPoints, ourCount, minutes });

  // Mesmo canal em war e territory? Envia uma vez só (dedup por id).
  const byId = new Map();
  const terrChannel = await fetchChannel(client, cfg.channels?.territory);
  const warChannel = await fetchChannel(client, cfg.channels?.war);
  if (terrChannel) byId.set(terrChannel.id, terrChannel);
  if (warChannel) byId.set(warChannel.id, warChannel);
  for (const ch of byId.values()) await ch.send(payload).catch(() => {});
}
