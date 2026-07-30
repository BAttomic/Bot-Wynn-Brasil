import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { collections } from '../../db/mongo.js';
import {
  METRICS,
  parseStart,
  createEvent,
  getEvent,
  activeEvents,
  listEvents,
  defaultEvent,
  refreshScores,
  scoreboard,
  scoreCount,
  memberScore,
  renderEvent,
  ensureEventPanel,
  endEvent,
  formatValue,
  parsePrizes,
  renderPrizes,
  placeLabel,
} from '../../services/events.js';
import { takeSnapshots } from '../../services/progress.js';
import { audit } from '../../services/audit.js';

const unix = (d) => Math.floor(new Date(d).getTime() / 1000);

function isStaff(interaction) {
  return !!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

/** Resolve o evento pedido; sem id, cai no ativo mais próximo do fim. */
async function resolveEvent(interaction) {
  const id = interaction.options.getString('id');
  if (id) return getEvent(id.trim());
  return defaultEvent(interaction.guildId);
}

async function criar(interaction) {
  const nome = interaction.options.getString('nome', true);
  const metrica = interaction.options.getString('metrica', true);
  const dias = interaction.options.getNumber('dias', true);
  const premio = interaction.options.getString('premio', true);
  const descricao = interaction.options.getString('descricao') ?? '';
  const inicioRaw = interaction.options.getString('inicio');
  const pontos = interaction.options.getInteger('pontos') ?? 0;
  const canal = interaction.options.getChannel('canal');

  if (!METRICS[metrica]) return interaction.editReply('Métrica inválida.');
  if (dias <= 0 || dias > 365) return interaction.editReply('A duração precisa ficar entre 0 e 365 dias.');

  // Uma recompensa por premiado, na ordem do pódio. Sem `podio` explícito, quem
  // manda é a lista: `Idol, 2 Stx, 1 Stx` premia três.
  const premios = parsePrizes(premio);
  if (!premios.length) return interaction.editReply('Informe ao menos uma recompensa.');
  const podio = interaction.options.getInteger('podio') ?? Math.min(10, premios.length);
  if (premios.length > podio) {
    return interaction.editReply(
      `Você cadastrou **${premios.length}** recompensas mas só **${podio}** premiado(s). ` +
        'Aumente `podio` ou tire recompensas da lista.',
    );
  }

  const agora = new Date();
  let inicio = null;
  if (inicioRaw) {
    inicio = parseStart(inicioRaw, agora);
    if (!inicio) {
      return interaction.editReply(
        'Não entendi a data de início. Use `29/07 00:00`, `29/07/2026 00:00` ou `2026-07-29 00:00` (horário de Brasília).',
      );
    }
    if (inicio.getTime() < agora.getTime() - 60_000) {
      return interaction.editReply(
        `Essa data já passou (<t:${unix(inicio)}:f>). Um evento não conta o passado — escolha uma data futura ou omita \`inicio\` para começar agora.`,
      );
    }
  }

  // CORTE ENTRE O PASSADO E O EVENTO, para as métricas SEM gatilho.
  //
  // Guerra e XP só existem como delta da contagem diária, e esse delta atravessa
  // o momento em que o evento abre: o lançamento de amanhã cobre desde a
  // contagem de hoje, incluindo horas em que o evento nem existia. Apurar no
  // instante da abertura fecha esse pedaço no passado.
  //
  // Guild raid não precisa: o gatilho credita a tabela no instante da raid, e
  // uma raid terminada antes da abertura simplesmente não é creditada. Se o
  // evento é agendado, quem faz o corte é o eventTick, na hora de abrir.
  const precisaCorte = !METRICS[metrica].live && !inicio;
  const snapshot = precisaCorte ? await takeSnapshots() : null;

  const event = await createEvent({
    name: nome,
    metricKey: metrica,
    days: dias,
    prize: premio,
    description: descricao,
    startAt: inicio,
    podium: podio,
    points: pontos,
    guildDiscordId: interaction.guildId,
    createdBy: interaction.user.id,
    channelId: canal?.id ?? interaction.channelId,
  });

  // A tabela nasce vazia de propósito: o evento conta só daqui para a frente.
  const msg = await ensureEventPanel(interaction.client, event);

  audit(
    interaction.client,
    interaction.guildId,
    `🏆 Evento **${event.name}** (\`${event.eventId}\`, ${METRICS[metrica].label}) criado por <@${interaction.user.id}> — termina <t:${unix(event.endAt)}:f>.`,
  );

  const abertura = inicio
    ? `Abre <t:${unix(event.startAt)}:F> (<t:${unix(event.startAt)}:R>)`
    : 'Já está valendo';

  // Menos recompensas que premiados é permitido (os de baixo levam só os pontos),
  // mas é quase sempre um descuido — avisa sem barrar.
  const faltando =
    premios.length < event.podium
      ? `\n⚠️ Top ${event.podium} premiado(s), mas só **${premios.length}** recompensa(s) — do ${placeLabel(premios.length + 1)} para baixo ninguém leva item.`
      : '';

  return interaction.editReply(
    `🏆 Evento **${event.name}** criado (\`${event.eventId}\`).\n` +
      `Métrica: **${METRICS[metrica].label}** · ${abertura} · Termina <t:${unix(event.endAt)}:R> · Top **${event.podium}** premiado(s).\n` +
      `🎁 Recompensas:\n${renderPrizes(premio, event.podium)}${faltando}\n` +
      `Todo mundo começa do **zero**: só conta o que for feito depois da abertura.\n` +
      (METRICS[metrica].live
        ? '-# Cada guild raid é creditada no instante em que termina.\n'
        : '-# Guerras e XP entram na contagem de hora em hora.\n') +
      (msg
        ? `Painel publicado em <#${msg.channelId}> (atualiza sozinho).`
        : '⚠️ Não consegui publicar o painel — configure `/config channel key:events`.') +
      (precisaCorte && !snapshot
        ? '\n⚠️ Não consegui apurar agora (API do Wynncraft fora do ar). A primeira contagem ' +
          'pode incluir horas anteriores ao evento — rode `/points apurar` e recrie o evento se quiser um corte limpo.'
        : ''),
  );
}

async function ranking(interaction) {
  const event = await resolveEvent(interaction);
  if (!event) return interaction.editReply('Nenhum evento encontrado. Crie um com `/evento criar`.');

  // Ativo apura na hora; encerrado lê a tabela congelada.
  if (event.status === 'active') await refreshScores(event);

  const rows = await scoreboard(event.eventId, 15);
  const total = await scoreCount(event.eventId);

  // Posição de quem pediu, se estiver vinculado e pontuando.
  let me = null;
  const link = await collections.members().findOne({ discordId: interaction.user.id });
  if (link) {
    const mine = await memberScore(event.eventId, link.uuid);
    if (mine) me = { rank: mine.rank, value: mine.value };
  }

  return interaction.editReply({ embeds: [renderEvent(event, rows, { me, total })] });
}

async function listar(interaction) {
  const events = await listEvents();
  if (!events.length) return interaction.editReply('Nenhum evento registrado.');

  const rotulo = { active: '🟢 ativo', ended: '🏁 encerrado', cancelled: '❌ cancelado' };
  const lines = events.map((e) => {
    const metric = METRICS[e.metric];
    const vencedor = e.winners?.[0] ? ` — 🥇 ${e.winners[0].username}` : '';
    return (
      `• \`${e.eventId}\` **${e.name}** (${metric?.label ?? e.metric}) — ${rotulo[e.status] ?? e.status}` +
      ` · ${e.status === 'active' ? 'termina' : 'terminou'} <t:${unix(e.endAt)}:R>${vencedor}`
    );
  });
  return interaction.editReply(lines.join('\n').slice(0, 3900));
}

async function encerrar(interaction) {
  if (!isStaff(interaction)) return interaction.editReply('Apenas staff pode encerrar eventos.');

  const event = await resolveEvent(interaction);
  if (!event) return interaction.editReply('Nenhum evento encontrado.');
  if (event.status !== 'active') return interaction.editReply(`O evento \`${event.eventId}\` já está encerrado.`);

  const { winners } = await endEvent(interaction.client, event);
  const metric = METRICS[event.metric];

  audit(
    interaction.client,
    interaction.guildId,
    `🏁 Evento **${event.name}** encerrado por <@${interaction.user.id}> — ${winners.length} vencedor(es).`,
  );

  if (!winners.length) return interaction.editReply(`Evento \`${event.eventId}\` encerrado — ninguém pontuou.`);
  const lista = winners
    .map((w) => `${w.rank}º **${w.username}** (${formatValue(w.value, metric)} ${metric.unit})${w.points ? ` +${w.points} pts` : ''}`)
    .join('\n');
  return interaction.editReply(`Evento \`${event.eventId}\` encerrado:\n${lista}`);
}

async function cancelar(interaction) {
  if (!isStaff(interaction)) return interaction.editReply('Apenas staff pode cancelar eventos.');

  const event = await resolveEvent(interaction);
  if (!event) return interaction.editReply('Nenhum evento encontrado.');
  if (event.status !== 'active') return interaction.editReply(`O evento \`${event.eventId}\` já está encerrado.`);

  await endEvent(interaction.client, event, { cancelled: true });
  audit(interaction.client, interaction.guildId, `❌ Evento **${event.name}** cancelado por <@${interaction.user.id}>.`);
  return interaction.editReply(`Evento \`${event.eventId}\` cancelado — sem vencedores e sem prêmio.`);
}

async function apurar(interaction) {
  if (!isStaff(interaction)) return interaction.editReply('Apenas staff pode reapurar.');

  const events = await activeEvents(interaction.guildId);
  if (!events.length) return interaction.editReply('Nenhum evento ativo.');
  for (const e of events) {
    await refreshScores(e);
    await ensureEventPanel(interaction.client, e);
  }
  return interaction.editReply(`Tabela e painel reapurados para **${events.length}** evento(s) ativo(s).`);
}

export default {
  data: new SlashCommandBuilder()
    .setName('evento')
    .setDescription('Eventos de competição por guild raids, guerras ou XP')
    .addSubcommand((s) =>
      s
        .setName('criar')
        .setDescription('(Staff) Cria um evento: quem mais fizer no período leva a recompensa')
        .addStringOption((o) => o.setName('nome').setDescription('Nome do evento').setRequired(true).setMaxLength(60))
        .addStringOption((o) =>
          o
            .setName('metrica')
            .setDescription('O que vai ser contado')
            .setRequired(true)
            .addChoices(...Object.entries(METRICS).map(([value, m]) => ({ name: m.label, value }))),
        )
        .addNumberOption((o) =>
          o.setName('dias').setDescription('Duração em dias (ex.: 14 para 2 semanas)').setRequired(true).setMinValue(0.1).setMaxValue(365),
        )
        .addStringOption((o) =>
          o
            .setName('premio')
            .setDescription('Uma por premiado, separadas por vírgula (ex.: Idol, 2 Stx, 1 Stx)')
            .setRequired(true)
            .setMaxLength(400),
        )
        .addStringOption((o) =>
          o
            .setName('descricao')
            .setDescription('Texto livre do evento. Use \\n para quebrar linha')
            .setMaxLength(1000),
        )
        .addStringOption((o) =>
          o
            .setName('inicio')
            .setDescription('Quando abre, horário de Brasília (ex.: 29/07 00:00). Padrão: agora')
            .setMaxLength(20),
        )
        .addIntegerOption((o) =>
          o
            .setName('podio')
            .setDescription('Quantos colocados são premiados (padrão: o número de recompensas)')
            .setMinValue(1)
            .setMaxValue(10),
        )
        .addIntegerOption((o) =>
          o
            .setName('pontos')
            .setDescription('Pontos da guilda para o 1º lugar (cada posição abaixo leva metade)')
            .setMinValue(0)
            .setMaxValue(100000),
        )
        .addChannelOption((o) => o.setName('canal').setDescription('Onde publicar o painel (padrão: este canal)')),
    )
    .addSubcommand((s) =>
      s
        .setName('ranking')
        .setDescription('Mostra a tabela do evento')
        .addStringOption((o) => o.setName('id').setDescription('ID do evento (padrão: o ativo)')),
    )
    .addSubcommand((s) => s.setName('listar').setDescription('Lista os eventos'))
    .addSubcommand((s) =>
      s
        .setName('encerrar')
        .setDescription('(Staff) Encerra agora, apura e anuncia os vencedores')
        .addStringOption((o) => o.setName('id').setDescription('ID do evento (padrão: o ativo)')),
    )
    .addSubcommand((s) =>
      s
        .setName('cancelar')
        .setDescription('(Staff) Cancela o evento sem premiar ninguém')
        .addStringOption((o) => o.setName('id').setDescription('ID do evento (padrão: o ativo)')),
    )
    .addSubcommand((s) => s.setName('apurar').setDescription('(Staff) Reapura a tabela e o painel agora'))
    .toJSON(),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const publico = sub === 'ranking' || sub === 'listar';
    await interaction.deferReply({ ephemeral: !publico });

    if (sub === 'criar') {
      if (!isStaff(interaction)) return interaction.editReply('Apenas staff pode criar eventos.');
      return criar(interaction);
    }
    if (sub === 'ranking') return ranking(interaction);
    if (sub === 'listar') return listar(interaction);
    if (sub === 'encerrar') return encerrar(interaction);
    if (sub === 'cancelar') return cancelar(interaction);
    return apurar(interaction);
  },
};
