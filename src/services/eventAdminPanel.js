import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { collections } from '../db/mongo.js';
import {
  METRICS,
  listEvents,
  getEvent,
  endEvent,
  pauseEvent,
  resumeEvent,
  scoreboard,
  scoreCount,
  scoreTotal,
  recentCredits,
  formatValue,
  formatShare,
  poolShares,
  plural,
  renderPrizes,
} from './events.js';
import { blockMember, unblockMember, listBlocks, countBlocks, findBlock } from './eventBlacklist.js';
import { wynn } from '../wynn/api.js';
import { audit } from './audit.js';
import { log } from '../util/log.js';

// Painel de staff do /evento listar. Tudo aqui é EFÊMERO: a mensagem existe só
// para quem rodou o comando, então o estado (filtro escolhido, evento aberto)
// pode viajar nos próprios customId em vez de ir para o banco — não há uma
// segunda pessoa vendo a mesma mensagem para sincronizar.
//
//   ev:f:<status>          troca o filtro da lista
//   ev:sel:<status>        select de evento (o status volta para não perder o filtro)
//   ev:pause:<id>          pausa ou retoma, conforme o estado atual
//   ev:end:<id>            encerra e apura o pódio
//   ev:cancel:<id>         cancela sem vencedores
//   ev:bl:<status>:<id>    abre a lista negra
//   ev:bladd:<status>:<id> modal para barrar alguém
//   ev:blrm                select de quem desbarrar
export const ADMIN_PREFIX = 'ev:';

const FILTROS = Object.freeze({
  todos: { label: 'Todos', emoji: '📋', status: null },
  active: { label: 'Ativos', emoji: '🟢', status: 'active' },
  paused: { label: 'Pausados', emoji: '⏸️', status: 'paused' },
  ended: { label: 'Encerrados', emoji: '🏁', status: 'ended' },
  cancelled: { label: 'Cancelados', emoji: '❌', status: 'cancelled' },
});

const STATUS_LABEL = Object.freeze({
  active: '🟢 ativo',
  paused: '⏸️ pausado',
  ended: '🏁 encerrado',
  cancelled: '❌ cancelado',
});

const ACAO_LABEL = Object.freeze({
  criado: '📝 criado',
  pausado: '⏸️ pausado',
  retomado: '▶️ retomado',
  encerrado: '🏁 encerrado',
  cancelado: '❌ cancelado',
});

const unix = (d) => Math.floor(new Date(d).getTime() / 1000);
const validoFiltro = (f) => (FILTROS[f] ? f : 'todos');

/** Quanto tempo o evento passou parado, em texto curto. */
function tempoParado(ms) {
  const min = Math.round((Number(ms) || 0) / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h}h${String(min % 60).padStart(2, '0')}`;
}

/** Uma linha por evento na visão de lista. */
function linhaEvento(e) {
  const metric = METRICS[e.metric];
  const quando = e.status === 'active' ? 'termina' : e.status === 'paused' ? 'pararia' : 'terminou';
  const vencedor = e.winners?.[0] ? ` · 🥇 ${e.winners[0].username}` : '';
  return (
    `${STATUS_LABEL[e.status] ?? e.status} \`${e.eventId}\` **${e.name}**\n` +
    `-# ${metric?.label ?? e.metric} · início <t:${unix(e.startAt)}:d> · ${quando} <t:${unix(e.endAt)}:R>${vencedor}`
  );
}

/** Detalhe de UM evento: números, prêmio, histórico e quem pontuou por último. */
async function detalheEvento(event) {
  const metric = METRICS[event.metric] ?? { label: event.metric, unit: '', emoji: '🏆' };
  const [rows, participantes, soma, ultimos] = await Promise.all([
    scoreboard(event.eventId, event.podium),
    scoreCount(event.eventId),
    scoreTotal(event.eventId),
    recentCredits(event.eventId, 5),
  ]);

  const fatias = event.prizePool?.total
    ? poolShares(rows.filter((r) => Number(r.value) > 0), event.prizePool.total)
    : null;

  const podio = rows.length
    ? rows
        .map((r, i) => {
          const fatia = fatias?.get(r.uuid);
          const premio = fatia ? ` — 🎁 ${formatShare(fatia)} ${event.prizePool.currency}` : '';
          return `\`${i + 1}.\` **${r.username}** — ${formatValue(r.value, metric)} ${plural(r.value, metric.unit)}${premio}`;
        })
        .join('\n')
    : '_Ninguém pontuou._';

  const historico = (event.history ?? [])
    .slice(-6)
    .map((h) => `-# ${ACAO_LABEL[h.action] ?? h.action} <t:${unix(h.at)}:R>${h.by ? ` por <@${h.by}>` : ''}`)
    .join('\n');

  const credito = ultimos.length
    ? ultimos
        .map((r) => `-# **${r.username}** — ${formatValue(r.value, metric)} ${plural(r.value, metric.unit)} · <t:${unix(r.updatedAt ?? r.reachedAt)}:R>`)
        .join('\n')
    : '-# _Sem crédito ainda._';

  const premio = event.prizePool?.total
    ? `**${formatShare(event.prizePool.total)} ${event.prizePool.currency}** divididos entre o top ${event.podium}`
    : renderPrizes(event.prize, event.podium);

  const fields = [
    {
      name: '📊 Números',
      value:
        `${STATUS_LABEL[event.status] ?? event.status} · **${participantes}** no ranking\n` +
        (METRICS[event.metric]?.live
          ? `🛡️ **${event.raids ?? 0}** ${plural(event.raids ?? 0, 'raids')} da guilda · **${soma}** ${plural(soma, 'créditos')} distribuídos`
          : `${metric.emoji} **${formatValue(soma, metric)} ${metric.unit}** somando todos`) +
        (event.pausedMs ? `\n⏸️ ficou **${tempoParado(event.pausedMs)}** parado` : ''),
      inline: false,
    },
    { name: '🎁 Recompensa', value: premio, inline: false },
    { name: `🏅 Pódio (top ${event.podium})`, value: podio.slice(0, 1024), inline: false },
    { name: '🕒 Últimos a pontuar', value: credito.slice(0, 1024), inline: false },
  ];
  if (historico) fields.push({ name: '📜 Histórico', value: historico.slice(0, 1024), inline: false });

  return {
    title: `${STATUS_LABEL[event.status]?.slice(0, 2) ?? '🏆'} ${event.name}`,
    description:
      `\`${event.eventId}\` · ${metric.label}\n` +
      `📅 <t:${unix(event.startAt)}:f> → <t:${unix(event.endAt)}:f>`,
    color: event.status === 'active' ? 0xe67e22 : event.status === 'paused' ? 0xf39c12 : 0x95a5a6,
    fields,
  };
}

/** Linha de filtros. O ativo fica azul, como no painel de leaderboard. */
function filtroRow(filtro) {
  return new ActionRowBuilder().addComponents(
    ...Object.entries(FILTROS).map(([id, f]) =>
      new ButtonBuilder()
        .setCustomId(`${ADMIN_PREFIX}f:${id}`)
        .setLabel(f.label)
        .setEmoji(f.emoji)
        .setStyle(id === filtro ? ButtonStyle.Primary : ButtonStyle.Secondary),
    ),
  );
}

/**
 * Select dos eventos listados. Desabilitado quando o filtro não devolveu nada —
 * um select vazio é recusado pelo Discord.
 */
function selectRow(events, filtro, eventId) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${ADMIN_PREFIX}sel:${filtro}`)
    .setPlaceholder(events.length ? 'Abrir um evento…' : 'Nenhum evento neste filtro');

  if (!events.length) {
    return new ActionRowBuilder().addComponents(
      menu.setDisabled(true).addOptions({ label: '—', value: 'vazio' }),
    );
  }
  return new ActionRowBuilder().addComponents(
    menu.addOptions(
      events.slice(0, 25).map((e) => ({
        label: e.name.slice(0, 100),
        value: e.eventId,
        description: `${STATUS_LABEL[e.status] ?? e.status} · ${METRICS[e.metric]?.label ?? e.metric}`.slice(0, 100),
        default: e.eventId === eventId,
      })),
    ),
  );
}

/** Ações do evento aberto. Some quando nenhum está aberto. */
function acoesRow(event) {
  const vivo = event.status === 'active' || event.status === 'paused';
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${ADMIN_PREFIX}pause:${event.eventId}`)
      .setLabel(event.status === 'paused' ? 'Retomar' : 'Pausar')
      .setEmoji(event.status === 'paused' ? '▶️' : '⏸️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!vivo),
    new ButtonBuilder()
      .setCustomId(`${ADMIN_PREFIX}end:${event.eventId}`)
      .setLabel('Encerrar e premiar')
      .setEmoji('🏁')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!vivo),
    new ButtonBuilder()
      .setCustomId(`${ADMIN_PREFIX}cancel:${event.eventId}`)
      .setLabel('Cancelar')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!vivo),
  );
}

/** Atalhos da lista negra, sempre disponíveis. */
function blacklistRow(filtro, eventId) {
  const sufixo = `${filtro}:${eventId ?? ''}`;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${ADMIN_PREFIX}bl:${sufixo}`)
      .setLabel('Lista negra')
      .setEmoji('🚫')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${ADMIN_PREFIX}bladd:${sufixo}`)
      .setLabel('Barrar alguém')
      .setEmoji('➕')
      .setStyle(ButtonStyle.Danger),
  );
}

/**
 * O painel inteiro.
 *
 * @param {{filtro?: string, eventId?: string|null}} [opts]
 */
export async function buildEventAdminPanel({ filtro = 'todos', eventId = null } = {}) {
  const f = validoFiltro(filtro);
  const events = await listEvents({ status: FILTROS[f].status, limit: 25 });
  const aberto = eventId ? await getEvent(eventId) : null;

  const embed = aberto
    ? await detalheEvento(aberto)
    : {
        title: '🏆 Eventos',
        description: events.length
          ? events.map(linhaEvento).join('\n\n').slice(0, 4000)
          : '_Nenhum evento neste filtro._',
        color: 0x3498db,
        footer: { text: `${events.length} evento(s) · ${FILTROS[f].label}` },
      };

  const components = [filtroRow(f), selectRow(events, f, eventId)];
  if (aberto) components.push(acoesRow(aberto));
  components.push(blacklistRow(f, aberto?.eventId));

  return { embeds: [embed], components, ephemeral: true };
}

/** Embed da lista negra, com o select de remoção. */
async function blacklistView(filtro, eventId) {
  const [rows, total] = await Promise.all([listBlocks(25), countBlocks()]);
  const linhas = rows.map((b) => {
    const nicks = (b.usernames || []).join(', ') || '`?`';
    const discords = (b.discordIds || []).map((id) => `<@${id}>`).join(', ') || '—';
    return `• **${nicks}** — ${discords}\n-# \`${b.uuid}\` · <t:${unix(b.blockedAt)}:d> · *${b.reason}*`;
  });

  const voltar = new ButtonBuilder()
    .setCustomId(`${ADMIN_PREFIX}f:${filtro}`)
    .setLabel('Voltar aos eventos')
    .setEmoji('↩️')
    .setStyle(ButtonStyle.Secondary);
  const barrar = new ButtonBuilder()
    .setCustomId(`${ADMIN_PREFIX}bladd:${filtro}:${eventId ?? ''}`)
    .setLabel('Barrar alguém')
    .setEmoji('➕')
    .setStyle(ButtonStyle.Danger);

  const components = [];
  if (rows.length) {
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${ADMIN_PREFIX}blrm:${filtro}`)
          .setPlaceholder('Tirar alguém da lista negra…')
          .addOptions(
            rows.map((b) => ({
              label: (b.usernames?.[0] ?? b.uuid).slice(0, 100),
              value: b.uuid,
              description: String(b.reason ?? '').slice(0, 100) || 'sem motivo',
            })),
          ),
      ),
    );
  }
  components.push(new ActionRowBuilder().addComponents(voltar, barrar));

  return {
    embeds: [
      {
        title: `🚫 Barrados de eventos (${total})`,
        description: linhas.join('\n').slice(0, 4000) || '_Ninguém na lista negra._',
        color: 0xe74c3c,
        footer: {
          text: 'Quem está aqui continua PONTUANDO — o crédito é gravado, só não aparece no ranking nem leva prêmio.',
        },
      },
    ],
    components,
  };
}

/** Mesma resolução do /evento blacklist add: vínculo no banco primeiro, API depois. */
async function resolveAlvo(termo) {
  const alvo = String(termo ?? '').trim();
  if (!alvo) return null;

  const porId = alvo.replace(/[<@!>]/g, '');
  if (/^\d{15,}$/.test(porId)) {
    const linked = await collections.members().findOne({ discordId: porId });
    if (linked) return { uuid: linked.uuid, username: linked.username, discordId: porId };
    const prior = await findBlock({ discordId: porId });
    if (prior) return { uuid: prior.uuid, username: prior.usernames?.[0] ?? null, discordId: porId };
    return null;
  }

  const linked = await collections.members().findOne({ username: new RegExp(`^${alvo}$`, 'i') });
  if (linked) return { uuid: linked.uuid, username: linked.username, discordId: linked.discordId ?? null };
  const player = await wynn.player(alvo).catch(() => null);
  return player?.uuid ? { uuid: player.uuid, username: player.username, discordId: null } : null;
}

/**
 * Roteia todo componente `ev:*`.
 *
 * Cada clique responde reeditando a própria mensagem efêmera: o estado (filtro,
 * evento aberto) sai do customId que acabou de ser clicado, então não há nada
 * para guardar entre uma interação e outra.
 */
export async function handleEventAdmin(interaction, { isStaff }) {
  const id = interaction.customId;
  const [, acao, ...resto] = id.split(':');

  // O modal é o único que não pode ser deferido antes: showModal É a resposta.
  if (acao === 'bladd') {
    if (!isStaff) return interaction.reply({ content: 'Apenas staff pode barrar.', ephemeral: true });
    const [filtro = 'todos', eventId = ''] = resto;
    return interaction.showModal(
      new ModalBuilder()
        .setCustomId(`${ADMIN_PREFIX}blsave:${filtro}:${eventId}`)
        .setTitle('Barrar de eventos')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('alvo')
              .setLabel('Nick do WynnCraft ou ID do Discord')
              .setStyle(TextInputStyle.Short)
              .setRequired(true),
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('motivo')
              .setLabel('Motivo')
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setPlaceholder('Barrado pela staff'),
          ),
        ),
    );
  }

  if (acao === 'blsave') {
    if (!isStaff) return interaction.reply({ content: 'Apenas staff pode barrar.', ephemeral: true });
    await interaction.deferUpdate();
    const [filtro = 'todos', eventId = ''] = resto;
    const termo = interaction.fields.getTextInputValue('alvo');
    const motivo = interaction.fields.getTextInputValue('motivo')?.trim() || 'Barrado pela staff';

    const alvo = await resolveAlvo(termo);
    if (!alvo) {
      return interaction.followUp({
        content: `Não achei \`${termo}\`. Use o nick exato do WynnCraft ou o ID do Discord de alguém registrado.`,
        ephemeral: true,
      });
    }
    await blockMember({ ...alvo, reason: motivo, by: interaction.user.id });
    audit(
      interaction.client,
      interaction.guildId,
      `🚫 <@${interaction.user.id}> barrou **${alvo.username ?? alvo.uuid}** de todos os eventos.`,
    );
    log.info(`Lista negra: ${alvo.username ?? alvo.uuid} barrado por ${interaction.user.id}.`);
    return interaction.editReply(await blacklistView(filtro, eventId || null));
  }

  await interaction.deferUpdate();

  if (acao === 'f') {
    return interaction.editReply(await buildEventAdminPanel({ filtro: resto[0] }));
  }

  if (acao === 'sel') {
    return interaction.editReply(
      await buildEventAdminPanel({ filtro: resto[0], eventId: interaction.values?.[0] }),
    );
  }

  if (acao === 'bl') {
    const [filtro = 'todos', eventId = ''] = resto;
    return interaction.editReply(await blacklistView(filtro, eventId || null));
  }

  if (acao === 'blrm') {
    if (!isStaff) return interaction.followUp({ content: 'Apenas staff pode mexer na lista negra.', ephemeral: true });
    const uuid = interaction.values?.[0];
    const saiu = await unblockMember({ uuid });
    if (saiu) {
      audit(interaction.client, interaction.guildId, `✅ <@${interaction.user.id}> tirou \`${uuid}\` da lista negra de eventos.`);
    }
    return interaction.editReply(await blacklistView(resto[0] ?? 'todos', null));
  }

  // Daqui para baixo é ação sobre um evento, e toda uma exige staff.
  if (!isStaff) return interaction.followUp({ content: 'Apenas staff pode agir sobre eventos.', ephemeral: true });

  const eventId = resto[0];
  const event = await getEvent(eventId);
  if (!event) return interaction.followUp({ content: 'Evento não encontrado.', ephemeral: true });

  if (acao === 'pause') {
    const novo = event.status === 'paused'
      ? await resumeEvent(event, interaction.user.id)
      : await pauseEvent(event, interaction.user.id);
    if (!novo) return interaction.followUp({ content: 'Esse evento não está mais aberto.', ephemeral: true });

    const verbo = novo.status === 'paused' ? 'pausou' : 'retomou';
    audit(interaction.client, interaction.guildId, `⏸️ <@${interaction.user.id}> ${verbo} o evento **${event.name}**.`);
    return interaction.editReply(await buildEventAdminPanel({ filtro: 'todos', eventId }));
  }

  if (acao === 'end' || acao === 'cancel') {
    const cancelado = acao === 'cancel';
    // Pausado não passa pelo endEvent com o status que tem: ele apura em cima de
    // `status: active`. Retomar antes devolve o relógio e mantém a conta certa.
    const vivo = event.status === 'paused' ? await resumeEvent(event, interaction.user.id) : event;
    const { winners } = await endEvent(interaction.client, vivo, { cancelled: cancelado });

    audit(
      interaction.client,
      interaction.guildId,
      cancelado
        ? `❌ Evento **${event.name}** cancelado por <@${interaction.user.id}>.`
        : `🏁 Evento **${event.name}** encerrado por <@${interaction.user.id}> — ${winners.length} vencedor(es).`,
    );
    return interaction.editReply(await buildEventAdminPanel({ filtro: 'todos', eventId }));
  }

  return interaction.editReply(await buildEventAdminPanel({ filtro: 'todos' }));
}
