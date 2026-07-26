import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from 'discord.js';
import { collections } from '../../db/mongo.js';
import { getConfig } from '../../config/guildConfig.js';
import { audit } from '../../services/audit.js';
import { checkWarEligibility, grantWarRole, enqueueWar } from '../../services/warRole.js';

/**
 * Formulário de aplicação para guerra: três escolhas, nenhuma digitação.
 * Um modal do Discord só aceita campos de texto, então usamos menus de seleção
 * numa mensagem efêmera — ninguém digita "warrior" errado.
 */
const FORM_FIELDS = Object.freeze({
  classe: Object.freeze({
    label: 'Classe',
    placeholder: 'Sua classe exclusiva para guerra',
    options: Object.freeze(['Mage', 'Shaman', 'Warrior', 'Assassin', 'Archer']),
  }),
  interesse: Object.freeze({
    label: 'Interesse',
    placeholder: 'Qual cargo você quer',
    options: Object.freeze(['WAR', 'MAIN WAR']),
  }),
  funcao: Object.freeze({
    label: 'Função',
    placeholder: 'Sua função na guerra',
    options: Object.freeze(['DPS', 'Tank', 'Healer']),
  }),
});

/** @type {readonly string[]} */
const FIELD_KEYS = Object.freeze(Object.keys(FORM_FIELDS));

/** Rascunhos por usuário. Efêmeros — some se o bot reiniciar, e tudo bem. */
const drafts = new Map();
const DRAFT_TTL_MS = 15 * 60_000;

/** @param {string} userId @returns {Record<string, string>} */
function draftOf(userId) {
  const d = drafts.get(userId);
  if (d && Date.now() - d.at < DRAFT_TTL_MS) return d.values;
  const values = {};
  drafts.set(userId, { at: Date.now(), values });
  return values;
}

/** Monta o formulário refletindo o que já foi escolhido. */
function formPayload(userId) {
  const chosen = draftOf(userId);

  const rows = FIELD_KEYS.map((key) => {
    const field = FORM_FIELDS[key];
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`war:set:${key}`)
      .setPlaceholder(chosen[key] ? `${field.label}: ${chosen[key]}` : field.placeholder)
      .addOptions(field.options.map((o) => ({ label: o, value: o, default: chosen[key] === o })));
    return new ActionRowBuilder().addComponents(menu);
  });

  const missing = FIELD_KEYS.filter((k) => !chosen[k]);
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('war:send')
        .setLabel(missing.length ? `Faltam: ${missing.join(', ')}` : 'Enviar aplicação')
        .setEmoji('📩')
        .setStyle(missing.length ? ButtonStyle.Secondary : ButtonStyle.Success)
        .setDisabled(missing.length > 0),
    ),
  );

  return { content: 'Preencha os três campos e envie.', components: rows, ephemeral: true };
}

/** Texto do resultado, do ponto de vista de quem aplicou. */
function outcomeText({ outcome, state, days, min, interesse }) {
  const mainWarNote =
    interesse === 'MAIN WAR'
      ? '\nSeu interesse em **MAIN WAR** foi enviado para a staff — esse cargo continua sendo avaliado à mão.'
      : '';

  if (outcome === 'granted') {
    return `Cargo de guerra aplicado! Você já recebe os pings de convocação.${mainWarNote}`;
  }
  if (outcome === 'failed') {
    return `Sua aplicação foi registrada, mas não consegui aplicar o cargo agora (provavelmente permissão do bot). A staff foi avisada e resolve.${mainWarNote}`;
  }
  // Enfileirado: a espera é pelos dias de guilda.
  if (state === 'notMember') {
    return `Aplicação guardada! O cargo de guerra é para membros da **Wynn Brasil** — assim que você entrar na guilda e completar **${min} dias**, ele cai sozinho, sem precisar aplicar de novo.${mainWarNote}`;
  }
  if (days === null) {
    return `Aplicação guardada! Ainda não consegui confirmar sua data de entrada na guilda. Assim que você tiver **${min} dias**, o cargo cai sozinho.${mainWarNote}`;
  }
  const faltam = min - days;
  return `Aplicação guardada! O cargo de guerra exige **${min} dias** de guilda e você está há **${days}**. Falta${faltam === 1 ? '' : 'm'} **${faltam} dia${faltam === 1 ? '' : 's'}** — o cargo cai sozinho, sem precisar aplicar de novo.${mainWarNote}`;
}

const OUTCOME_LABEL = {
  granted: '✅ Cargo aplicado automaticamente',
  queued: '⏳ Na fila (tempo de guilda)',
  failed: '⚠️ Falha ao aplicar o cargo',
};

/**
 * Aplica o cargo WAR na hora (ou enfileira até a pessoa completar o tempo de
 * guilda) e publica a aplicação no canal da staff — que ainda decide o MAIN WAR
 * e acompanha quem entrou.
 */
async function sendWarApplication(interaction) {
  const chosen = draftOf(interaction.user.id);
  const missing = FIELD_KEYS.filter((k) => !chosen[k]);
  if (missing.length) {
    return interaction.reply({ content: `Faltam: ${missing.join(', ')}.`, ephemeral: true });
  }
  await interaction.deferUpdate();

  const cfg = await getConfig(interaction.guildId);
  const { state, days, min, linked } = await checkWarEligibility(
    interaction.guildId,
    interaction.user.id,
  );

  // Sem vínculo não há uuid para acompanhar o tempo de guilda: não dá nem para
  // conceder nem para enfileirar.
  if (state === 'unlinked') {
    return interaction.editReply({
      content: 'Antes de aplicar para guerra, registre seu nick do WynnCraft no canal de registro.',
      components: [],
    });
  }
  if (state === 'banned') {
    return interaction.editReply({
      content: 'Não consegui processar sua aplicação. Fale com a staff.',
      components: [],
    });
  }

  const application = { classe: chosen.classe, interesse: chosen.interesse, funcao: chosen.funcao };

  let outcome;
  if (state === 'ok') {
    outcome = (await grantWarRole(interaction.member, cfg)) ? 'granted' : 'failed';
  } else {
    await enqueueWar({
      guildDiscordId: interaction.guildId,
      discordId: interaction.user.id,
      uuid: linked.uuid,
      username: linked.username,
      application,
    });
    outcome = 'queued';
  }

  const channel = await interaction.client.channels
    .fetch(cfg.channels?.warApplication ?? interaction.channelId)
    .catch(() => null);
  if (channel) {
    await channel.send({
      embeds: [
        {
          title: '📩 Nova aplicação para guerra',
          color: 0xe74c3c,
          description: `**Jogador:** <@${interaction.user.id}>\n**Classe:** \`${chosen.classe}\`\n**Interesse:** \`${chosen.interesse}\`\n**Função:** \`${chosen.funcao}\`\n**Cargo WAR:** ${OUTCOME_LABEL[outcome]}`,
          thumbnail: { url: interaction.user.displayAvatarURL() },
          timestamp: new Date().toISOString(),
        },
      ],
      allowedMentions: { parse: [] },
    });
  }

  drafts.delete(interaction.user.id);
  audit(
    interaction.client,
    interaction.guildId,
    `:crossed_swords: <@${interaction.user.id}> aplicou para guerra (${chosen.interesse}) — ${OUTCOME_LABEL[outcome]}.`,
  );
  return interaction.editReply({
    content: outcomeText({ outcome, state, days, min, interesse: chosen.interesse }),
    components: [],
  });
}

function hasWarRole(member, cfg) {
  const ids = [cfg.roles?.war, cfg.roles?.mainWar].filter(Boolean);
  return ids.some((id) => member.roles.cache.has(id));
}

function warButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('war:att:yes').setLabel('Vou').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('war:att:no').setLabel('Não vou').setStyle(ButtonStyle.Danger),
  );
}

function callEmbed(call) {
  const going = call.going.map((id) => `<@${id}>`).join(', ') || '—';
  const not = call.notGoing.map((id) => `<@${id}>`).join(', ') || '—';
  return {
    title: ':crossed_swords: Convocação de Guerra!',
    description: call.note || 'Reúnam-se para a guerra!',
    color: 0xe67e22,
    fields: [
      { name: `Vou (${call.going.length})`, value: going },
      { name: `Não vou (${call.notGoing.length})`, value: not },
    ],
    footer: { text: `Chamado por ${call.createdByName}` },
  };
}

async function handleAttend(interaction, answer) {
  const warCalls = collections.warCalls();
  const call = await warCalls.findOne({ messageId: interaction.message.id });
  if (!call) return interaction.reply({ content: 'Convocação não encontrada.', ephemeral: true });

  const uid = interaction.user.id;
  const going = new Set(call.going);
  const notGoing = new Set(call.notGoing);
  going.delete(uid);
  notGoing.delete(uid);
  if (answer === 'yes') going.add(uid);
  else notGoing.add(uid);

  call.going = [...going];
  call.notGoing = [...notGoing];
  await warCalls.updateOne(
    { messageId: interaction.message.id },
    { $set: { going: call.going, notGoing: call.notGoing } },
  );
  await interaction.update({ embeds: [callEmbed(call)], components: [warButtons()] });
}

export default {
  data: new SlashCommandBuilder()
    .setName('war')
    .setDescription('(WAR/MAIN WAR) Dispara uma convocação de guerra')
    .addStringOption((o) => o.setName('nota').setDescription('Mensagem opcional').setRequired(false))
    .toJSON(),

  // war:att:* (convocação), war:apply, war:set:<campo>, war:send.
  owns(interaction) {
    return typeof interaction.customId === 'string' && interaction.customId.startsWith('war:');
  },

  async handleComponent(interaction) {
    const [, action, field] = interaction.customId.split(':');

    if (action === 'att') return handleAttend(interaction, field);
    if (action === 'apply') return interaction.reply(formPayload(interaction.user.id));
    if (action === 'send') return sendWarApplication(interaction);

    if (action === 'set' && FIELD_KEYS.includes(field)) {
      draftOf(interaction.user.id)[field] = interaction.values[0];
      const payload = formPayload(interaction.user.id);
      return interaction.update({ content: payload.content, components: payload.components });
    }
  },

  async execute(interaction) {
    const cfg = await getConfig(interaction.guildId);
    if (!hasWarRole(interaction.member, cfg)) {
      return interaction.reply({ content: 'Apenas cargos WAR / MAIN WAR podem convocar guerra.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });

    const note = interaction.options.getString('nota');
    const channelId = cfg.channels?.war;
    const channel = channelId
      ? await interaction.client.channels.fetch(channelId).catch(() => null)
      : interaction.channel;
    if (!channel) return interaction.editReply('Canal de guerra não configurado/acessível.');

    const roleId = cfg.roles?.war;
    const call = {
      going: [],
      notGoing: [],
      note,
      createdBy: interaction.user.id,
      createdByName: interaction.user.username,
    };
    const msg = await channel.send({
      content: roleId ? `<@&${roleId}>` : '',
      embeds: [callEmbed(call)],
      components: [warButtons()],
      allowedMentions: { roles: roleId ? [roleId] : [] },
    });
    await collections.warCalls().insertOne({
      messageId: msg.id,
      channelId: channel.id,
      guildDiscordId: interaction.guildId,
      createdAt: new Date(),
      ...call,
    });
    audit(interaction.client, interaction.guildId, `:crossed_swords: <@${interaction.user.id}> convocou guerra.`);
    return interaction.editReply('Convocação enviada!');
  },
};
