import { readFileSync } from 'node:fs';
import { wynn } from '../wynn/api.js';
import { collections } from '../db/mongo.js';
import { getConfig } from '../config/guildConfig.js';
import { optional } from '../config/env.js';
import { shortNumber, membersLimit, calcExperience, getByPath, diffPaths } from '../util/format.js';
import { xpBarEmoji } from '../util/emojis.js';

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

  return {
    embeds: [
      {
        title: `${guild.name} [${guild.prefix}]`,
        color: 0x2ecc71,
        description:
`**🎉 Nível:** \`${guild.level} (${guild.xpPercent}%)\` — \`${shortNumber(Math.floor(currXp))}/${shortNumber(Math.floor(reqXp))}\`
${xpBarEmoji(guild.xpPercent)}
**🚧 Territórios:** \`${guild.territories}\`
**⚔ Guerras:** \`${guild.wars}\`
**🤙 Membros:** \`${guild.members.total}/${membersLimit(guild.level)}\`

**Online (${online.length}/${guild.members.total}):**
${list}

-# Atualizado <t:${Math.floor(Date.now() / 1000)}:R>`,
        footer: { text: 'WnBR — Informações', iconURL: client.user.displayAvatarURL() },
      },
    ],
  };
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
      await msg.edit(payload).catch(() => {});
      return;
    }
  }
  const msg = await channel.send(payload);
  await state.updateOne(
    { _id: 'panel' },
    { $set: { messageId: msg.id, channelId: channel.id } },
    { upsert: true },
  );
}

async function handleGuildChanges(client, cfg, guild, old, changes) {
  const channel = await fetchChannel(client, cfg.channels?.activity);
  if (!channel) return;
  const seen = new Set();

  for (const path of changes) {
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
  const warRoleId = cfg.roles?.war;

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

    const info = territoryMap[name]?.resources || {};
    if (terrChannel) {
      await terrChannel.send({ embeds: [{
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

> Temos agora \`${ourCount}\` territórios.`,
        color: gained ? 0x00ff00 : 0xff0000,
        timestamp: iso(),
      }] }).catch(() => {});
    }

    if (warChannel) {
      await warChannel.send({
        content: `${warRoleId ? `<@&${warRoleId}> ` : ''}${lost ? '🚨 **Perdemos**' : '🟢 **Conquistamos**'} o território \`${name}\`!`,
        allowedMentions: { roles: warRoleId ? [warRoleId] : [] },
      }).catch(() => {});
    }
  }
}
