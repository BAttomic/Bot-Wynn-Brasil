import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import {
  REQUIREMENTS,
  createGiveaway,
  getGiveaway,
  listGiveaways,
  entryCount,
  toggleEntry,
  ensureGiveawayMessage,
  endGiveaway,
  rerollGiveaway,
} from '../../services/giveaways.js';
import { audit } from '../../services/audit.js';

const unix = (d) => Math.floor(new Date(d).getTime() / 1000);

function isStaff(interaction) {
  return !!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

async function criar(interaction) {
  const premio = interaction.options.getString('premio', true);
  const horas = interaction.options.getNumber('horas', true);
  const vagas = interaction.options.getInteger('vagas') ?? 1;
  const requisito = interaction.options.getString('requisito') ?? 'nenhum';
  const minPontos = interaction.options.getInteger('pontos_minimos') ?? 0;
  const canal = interaction.options.getChannel('canal');

  if (requisito === 'pontos' && minPontos <= 0) {
    return interaction.editReply('Com o requisito de pontos, informe `pontos_minimos` maior que zero.');
  }

  const gw = await createGiveaway({
    prize: premio,
    hours: horas,
    winnersCount: vagas,
    requirement: requisito,
    minPoints: minPontos,
    guildDiscordId: interaction.guildId,
    createdBy: interaction.user.id,
    channelId: canal?.id ?? interaction.channelId,
  });

  const msg = await ensureGiveawayMessage(interaction.client, gw);
  if (!msg) {
    return interaction.editReply('⚠️ Não consegui publicar o sorteio. Confira as permissões do canal.');
  }

  audit(
    interaction.client,
    interaction.guildId,
    `🎁 Sorteio de **${gw.prize}** (\`${gw.giveawayId}\`) criado por <@${interaction.user.id}> — sorteia <t:${unix(gw.endAt)}:f>.`,
  );

  return interaction.editReply(
    `🎁 Sorteio publicado em <#${msg.channelId}> (\`${gw.giveawayId}\`).\n` +
      `Sorteia <t:${unix(gw.endAt)}:R> · **${gw.winnersCount}** vaga(s) · ${REQUIREMENTS[gw.requirement].label}.`,
  );
}

async function encerrar(interaction) {
  if (!isStaff(interaction)) return interaction.editReply('Apenas staff pode encerrar sorteios.');

  const id = interaction.options.getString('id', true).trim();
  const gw = await getGiveaway(id);
  if (!gw) return interaction.editReply(`Não achei o sorteio \`${id}\`.`);
  if (gw.status !== 'active') return interaction.editReply(`O sorteio \`${id}\` já foi sorteado.`);

  const { winners } = await endGiveaway(interaction.client, gw);
  audit(interaction.client, interaction.guildId, `🎉 Sorteio \`${id}\` encerrado por <@${interaction.user.id}>.`);
  return interaction.editReply(
    winners.length
      ? `Sorteado: ${winners.map((w) => `<@${w.discordId}>`).join(', ')}.`
      : 'Sorteio encerrado — ninguém participou.',
  );
}

async function reroll(interaction) {
  if (!isStaff(interaction)) return interaction.editReply('Apenas staff pode re-sortear.');

  const id = interaction.options.getString('id', true).trim();
  const gw = await getGiveaway(id);
  if (!gw) return interaction.editReply(`Não achei o sorteio \`${id}\`.`);

  const res = await rerollGiveaway(interaction.client, gw);
  if (!res) return interaction.editReply('Só dá para re-sortear um sorteio já encerrado.');

  audit(interaction.client, interaction.guildId, `🔁 Sorteio \`${id}\` re-sorteado por <@${interaction.user.id}>.`);
  return interaction.editReply(
    res.winners.length
      ? `Novo sorteio: ${res.winners.map((w) => `<@${w.discordId}>`).join(', ')}.`
      : 'Não sobrou nenhum participante elegível para o re-sorteio.',
  );
}

async function listar(interaction) {
  const gws = await listGiveaways();
  if (!gws.length) return interaction.editReply('Nenhum sorteio registrado.');

  const lines = [];
  for (const g of gws) {
    const total = await entryCount(g.giveawayId);
    const estado = g.status === 'active' ? '🟢 aberto' : '🏁 sorteado';
    const vencedores = g.winners?.length ? ` — 🎉 ${g.winners.map((w) => `<@${w.discordId}>`).join(', ')}` : '';
    lines.push(
      `• \`${g.giveawayId}\` **${g.prize}** — ${estado} · ${total} inscrito(s) · ` +
        `${g.status === 'active' ? 'sorteia' : 'sorteou'} <t:${unix(g.endAt)}:R>${vencedores}`,
    );
  }
  return interaction.editReply({
    content: lines.join('\n').slice(0, 3900),
    allowedMentions: { parse: [] },
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Sorteios com inscrição por botão')
    .addSubcommand((s) =>
      s
        .setName('criar')
        .setDescription('(Staff) Publica um sorteio com botão de participar')
        .addStringOption((o) => o.setName('premio').setDescription('O que está sendo sorteado').setRequired(true).setMaxLength(200))
        .addNumberOption((o) =>
          o.setName('horas').setDescription('Duração em horas (ex.: 48)').setRequired(true).setMinValue(0.1).setMaxValue(2160),
        )
        .addIntegerOption((o) => o.setName('vagas').setDescription('Quantos vencedores (padrão: 1)').setMinValue(1).setMaxValue(20))
        .addStringOption((o) =>
          o
            .setName('requisito')
            .setDescription('Quem pode participar (padrão: todos)')
            .addChoices(...Object.entries(REQUIREMENTS).map(([value, r]) => ({ name: r.label, value }))),
        )
        .addIntegerOption((o) =>
          o.setName('pontos_minimos').setDescription('Pontos exigidos (com o requisito "Pontos mínimos")').setMinValue(1),
        )
        .addChannelOption((o) => o.setName('canal').setDescription('Onde publicar (padrão: este canal)')),
    )
    .addSubcommand((s) =>
      s
        .setName('encerrar')
        .setDescription('(Staff) Sorteia agora, sem esperar o prazo')
        .addStringOption((o) => o.setName('id').setDescription('ID do sorteio').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('reroll')
        .setDescription('(Staff) Sorteia de novo, excluindo quem já ganhou')
        .addStringOption((o) => o.setName('id').setDescription('ID do sorteio').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('listar').setDescription('Lista os sorteios'))
    .toJSON(),

  owns(interaction) {
    return typeof interaction.customId === 'string' && interaction.customId.startsWith('gw:');
  },

  // Botão "Participar": alterna entrar/sair e atualiza o contador na mensagem.
  async handleComponent(interaction) {
    const [, action, giveawayId] = interaction.customId.split(':');
    if (action !== 'join') return;

    await interaction.deferReply({ ephemeral: true });
    const gw = await getGiveaway(giveawayId);
    if (!gw) return interaction.editReply('Este sorteio não existe mais.');

    const res = await toggleEntry(gw, interaction.user.id);
    if (res.status === 'closed') return interaction.editReply('Este sorteio já encerrou.');
    if (res.status === 'blocked') return interaction.editReply(`❌ ${res.reason}`);

    // O contador de participantes vive no embed; reeditar mantém a mensagem viva.
    await ensureGiveawayMessage(interaction.client, gw);

    return interaction.editReply(
      res.status === 'joined'
        ? `🎉 Você está participando do sorteio de **${gw.prize}**! (${res.total} inscrito(s))\n-# Clique no botão de novo se quiser sair.`
        : `👋 Você saiu do sorteio de **${gw.prize}**. (${res.total} inscrito(s))`,
    );
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ ephemeral: sub !== 'listar' });

    if (sub === 'criar') {
      if (!isStaff(interaction)) return interaction.editReply('Apenas staff pode criar sorteios.');
      return criar(interaction);
    }
    if (sub === 'encerrar') return encerrar(interaction);
    if (sub === 'reroll') return reroll(interaction);
    return listar(interaction);
  },
};
