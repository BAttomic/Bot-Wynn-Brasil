import { SlashCommandBuilder } from 'discord.js';
import { collections } from '../../db/mongo.js';
import { getConfig } from '../../config/guildConfig.js';

const DAY_MS = 86_400_000;

/** @param {Date} d @returns {number} epoch em segundos, p/ <t:…> do Discord. */
const unix = (d) => Math.floor(new Date(d).getTime() / 1000);

/** Botão que o dono usa para parar os avisos (ex.: perdeu o local). */
function stopButtonRow(discordId) {
  return {
    type: 1, // action row
    components: [
      { type: 2, style: 4, label: 'Parar avisos', emoji: { name: '🔕' }, custom_id: `booth:stop:${discordId}` },
    ],
  };
}

/** Registra (ou renova) o booth do usuário e reinicia o ciclo de 24h. */
async function register(interaction) {
  const location = interaction.options.getString('localizacao', true).trim();
  const now = new Date();
  const nextResetAt = new Date(now.getTime() + DAY_MS);

  await collections.booths().updateOne(
    { discordId: interaction.user.id },
    {
      $set: {
        discordId: interaction.user.id,
        guildDiscordId: interaction.guildId,
        location,
        placedAt: now,
        nextResetAt,
        notifiedForReset: false,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );

  const cfg = await getConfig(interaction.guildId);
  const aviso = cfg.channels?.booth
    ? `Vou te avisar ~5 min antes de cada reset (o próximo é <t:${unix(nextResetAt)}:R>).`
    : '⚠️ Nenhum canal de avisos configurado ainda (a staff define com `/config channel key:booth`), ' +
      'então o lembrete não vai sair até lá.';

  return interaction.editReply(
    `📦 Booth registrado em **${location}**.\n${aviso}\n` +
      '-# Os avisos repetem a cada 24h. Pare com o botão **Parar avisos** na notificação ou com `/booth cancelar`.',
  );
}

/** Mostra o booth atual do usuário. */
async function status(interaction) {
  const booth = await collections.booths().findOne({ discordId: interaction.user.id });
  if (!booth) {
    return interaction.editReply('Você não tem booth registrado. Use `/booth registrar <localização>`.');
  }
  return interaction.editReply(
    `📦 Seu booth está em **${booth.location}**.\nPróximo reset: <t:${unix(booth.nextResetAt)}:R> (<t:${unix(booth.nextResetAt)}:t>).`,
  );
}

/** Cancela o booth do usuário (para os avisos). */
async function cancel(interaction) {
  const res = await collections.booths().deleteOne({ discordId: interaction.user.id });
  return interaction.editReply(
    res.deletedCount ? '🔕 Avisos de booth cancelados.' : 'Você não tinha booth registrado.',
  );
}

export default {
  data: new SlashCommandBuilder()
    .setName('booth')
    .setDescription('Lembrete de reset do seu booth (24h)')
    .addSubcommand((s) =>
      s
        .setName('registrar')
        .setDescription('Registra/renova seu booth e ativa o aviso 5 min antes de cada reset')
        .addStringOption((o) =>
          o.setName('localizacao').setDescription('Onde você colocou o booth').setRequired(true),
        ),
    )
    .addSubcommand((s) => s.setName('status').setDescription('Mostra seu booth e quando ele reseta'))
    .addSubcommand((s) => s.setName('cancelar').setDescription('Para os avisos do seu booth'))
    .toJSON(),

  owns(interaction) {
    return typeof interaction.customId === 'string' && interaction.customId.startsWith('booth:');
  },

  // Botão "Parar avisos" da notificação: só o dono pode usar o seu.
  async handleComponent(interaction) {
    const [, action, targetId] = interaction.customId.split(':');
    if (action !== 'stop') return;

    if (interaction.user.id !== targetId) {
      return interaction.reply({ content: 'Esse botão é do booth de outra pessoa.', ephemeral: true });
    }
    await collections.booths().deleteOne({ discordId: targetId });
    // Reflete o estado na própria mensagem e tira o botão.
    return interaction.update({
      content: `${interaction.message.content}\n-# 🔕 Avisos parados por <@${targetId}>.`,
      components: [],
      allowedMentions: { parse: [] },
    });
  },

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const sub = interaction.options.getSubcommand();
    if (sub === 'registrar') return register(interaction);
    if (sub === 'status') return status(interaction);
    return cancel(interaction);
  },

  // Exportado para o job de lembretes montar o botão da notificação.
  stopButtonRow,
};
