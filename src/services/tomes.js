import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { collections } from '../db/mongo.js';
import { getConfig } from '../config/guildConfig.js';
import { ensurePanel } from './panels.js';
import { pendingAspects } from './aspects.js';
import { brandWithLogo, logoAttachment } from '../util/assets.js';

const STATE_ID = 'tomePanel';
const TOP = 10; // linhas de cada seção no painel ao vivo

// A prioridade da fila de Tomes usa o sistema de pontos unificado (design.md §17):
// quem tem mais pontos (guerras + raids + contribuição + eventos) vem primeiro.
export async function rankedQueue() {
  const queue = await collections.tomeQueue().find({}).toArray();
  if (!queue.length) return [];
  const uuids = queue.map((q) => q.uuid);
  const stats = await collections.guildStats().find({ uuid: { $in: uuids } }).toArray();
  const byUuid = new Map(stats.map((s) => [s.uuid, s]));
  return queue
    .map((q) => ({ ...q, points: byUuid.get(q.uuid)?.points ?? 0 }))
    .sort((a, b) => b.points - a.points);
}

function fmtAsp(n) {
  return n.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
}

function btn(id, label, emoji, style) {
  return new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);
}

// Painel AO VIVO do canal de tomes/aspects: fila de Tomes (por pontos) + aspects
// gerados em guild raids ainda a entregar. Republicado pelo job de painéis e
// logo após cada ação (entrar/sair da fila, entregar tome/aspect).
export async function buildTomePanel(guildId) {
  const queue = await rankedQueue();
  const pending = await pendingAspects(guildId);

  const queueLines = queue
    .slice(0, TOP)
    .map((r, i) => `\`${String(i + 1).padStart(2, ' ')}.\` **${r.username}** — ${r.points} pts`);
  const aspectLines = pending
    .slice(0, TOP)
    .map((a) => `**${a.username}** — ${fmtAsp(a.pending)} a entregar · gerou ${fmtAsp(a.earned)} (${a.raids} raids)`);

  const embed = {
    title: '📜 Tomes & ✨ Aspects — Wynn Brasil',
    color: 0x9b59b6,
    description:
      'Entre na **fila de Tomes** (ordenada por pontos de contribuição) e acompanhe os **aspects** que você gerou em guild raids, a serem entregues pela staff.',
    fields: [
      {
        name: `📜 Fila de Tomes (${queue.length})`,
        value: queueLines.join('\n') || 'Fila vazia — clique em **Entrar na fila**.',
      },
      {
        name: `✨ Aspects a entregar (${pending.length})`,
        value: aspectLines.join('\n') || 'Nada pendente 🎉',
      },
    ],
    footer: { text: 'Fila por pontos · aspects: 0,5 por guild raid · apurado 1x/dia' },
    timestamp: new Date().toISOString(),
  };

  return brandWithLogo({
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        btn('tome:join', 'Entrar na fila', '📜', ButtonStyle.Success),
        btn('tome:leave', 'Sair da fila', '🚪', ButtonStyle.Danger),
        btn('tome:queue', 'Ver fila', '📋', ButtonStyle.Secondary),
      ),
      new ActionRowBuilder().addComponents(
        btn('tome:deliver', 'Entregar Tome', '🎁', ButtonStyle.Primary),
        btn('tome:deliverAspect', 'Entregar Aspect', '✨', ButtonStyle.Primary),
      ),
    ],
  });
}

export async function ensureTomePanel(client, guildId) {
  const cfg = await getConfig(guildId);
  return ensurePanel(client, cfg.channels?.tome, STATE_ID, await buildTomePanel(guildId), 'tomes', [logoAttachment()]);
}
