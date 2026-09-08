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
import { queueApplications, markInvited, unmarkInvited, dropFromQueue, addToQueue } from './applications.js';
import { parseStart } from './events.js';
import { fetchGuildMembers } from './guildData.js';
import { optional } from '../config/env.js';
import { wynn } from '../wynn/api.js';
import { audit } from './audit.js';
import { log } from '../util/log.js';

// Painel de CRUD da fila de entrada, efêmero e só para staff.
//
//   fila:sel          escolhe quem editar
//   fila:inv:<id>     modal do convite (aceita data passada)
//   fila:invsave:<id> grava o convite
//   fila:desinv:<id>  desfaz o convite marcado por engano
//   fila:sai:<id>     tira da fila sem ter entrado
//   fila:add          modal para pôr alguém na fila
//   fila:addsave      grava
//   fila:volta        volta para a lista sem ninguém selecionado
//
// NÃO existe "já entrou": entrar na guilda é fato observável no roster, e o
// roleSync fecha a candidatura sozinho ao ver a pessoa lá. Um botão para isso
// seria uma segunda fonte de verdade para a mesma pergunta — e a pior das duas,
// porque depende de alguém lembrar de clicar. O que sobra para a staff é o que a
// guilda NÃO consegue observar: o convite que saiu, e quem desistiu.
export const QUEUE_PREFIX = 'fila:';

const unix = (d) => Math.floor(new Date(d).getTime() / 1000);

/**
 * Data que o usuário digitou, entendida como PASSADO.
 *
 * `parseStart` existe para agendar evento, então quando o ano é omitido ele
 * assume o ano que vem — "05/09" em setembro vira 2027. Aqui é o contrário: o
 * convite que a staff está registrando já foi enviado. Data no futuro volta um
 * ano; data futura de verdade é erro de digitação e não faz sentido guardar.
 *
 * @returns {{at: Date}|{erro: string}}
 */
export function parseQuando(texto) {
  const cru = String(texto ?? '').trim();
  if (!cru) return { at: new Date() };

  const d = parseStart(cru);
  if (!d) return { erro: 'Não entendi a data. Use `05/09`, `05/09 14:30` ou `2026-09-05`.' };

  const agora = new Date();
  if (d <= agora) return { at: d };

  // Só recua quando o ano foi INFERIDO. Quem escreveu o ano escreveu o que
  // queria: virar 2026 em 2025 caladamente seria trocar a data da pessoa por
  // outra sem ela pedir — aí é melhor recusar e deixar corrigir.
  const temAno = /^\d{4}-/.test(cru) || /^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(cru);
  if (temAno) {
    return { erro: 'Essa data está no futuro. O convite registrado aqui é um que já foi enviado.' };
  }

  const anoAtras = new Date(d);
  anoAtras.setFullYear(anoAtras.getFullYear() - 1);
  return { at: anoAtras };
}

/**
 * A fila, já sem quem está na guilda.
 *
 * Sair da fila é AUTOMÁTICO e não tem botão: quem aparece no roster teve a
 * candidatura fechada pelo roleSync. Aqui o roster é consultado de novo, ao
 * vivo, porque o job roda a cada 10 min e ninguém precisa ver na fila alguém que
 * entrou faz cinco. Se a API estiver fora, cai no `inGuild` do banco — atrasado,
 * mas melhor que listar a guilda inteira como se estivesse esperando convite.
 */
async function filaAtual() {
  const apps = await queueApplications();
  const prefix = optional('WYNN_GUILD_PREFIX');
  const res = prefix ? await fetchGuildMembers(prefix).catch(() => null) : null;

  const dentro = new Set(
    res
      ? res.members.map((m) => m.uuid)
      : (await collections.members().find({ inGuild: true }, { projection: { uuid: 1 } }).toArray()).map((m) => m.uuid),
  );
  return apps.filter((a) => !dentro.has(a.uuid));
}

function linhaFila(a, i) {
  const quem = a.memberDiscordId ? ` <@${a.memberDiscordId}>` : '';
  const marca = a.status === 'invited'
    ? `✉️ convidado <t:${unix(a.invitedAt ?? a.decidedAt)}:R>`
    : '⏳ sem convite';
  const manual = a.manual ? ' · _entrou na fila pela staff_' : '';
  return (
    `\`${String(i + 1).padStart(2, ' ')}.\` **${a.username}**${quem}\n` +
    `-# aprovado <t:${unix(a.decidedAt)}:R> · ${marca}${manual}`
  );
}

function selectRow(fila, selecionado) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${QUEUE_PREFIX}sel`)
    .setPlaceholder(fila.length ? 'Editar alguém da fila…' : 'A fila está vazia');

  if (!fila.length) {
    return new ActionRowBuilder().addComponents(menu.setDisabled(true).addOptions({ label: '—', value: 'vazio' }));
  }
  return new ActionRowBuilder().addComponents(
    menu.addOptions(
      fila.slice(0, 25).map((a, i) => ({
        label: `${i + 1}. ${a.username}`.slice(0, 100),
        value: String(a._id),
        description: (a.status === 'invited' ? 'já convidado' : 'aguardando convite').slice(0, 100),
        default: String(a._id) === selecionado,
      })),
    ),
  );
}

function acoesRow(app) {
  const id = String(app._id);
  const convidado = app.status === 'invited';
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${QUEUE_PREFIX}${convidado ? 'desinv' : 'inv'}:${id}`)
      .setLabel(convidado ? 'Desfazer convite' : 'Marcar convite enviado')
      .setEmoji(convidado ? '↩️' : '✉️')
      .setStyle(convidado ? ButtonStyle.Secondary : ButtonStyle.Primary),
    // "Tirar da fila" é para quem NÃO vai entrar: desistiu, sumiu, mudou de
    // ideia. Quem entra sai daqui sozinho.
    new ButtonBuilder()
      .setCustomId(`${QUEUE_PREFIX}sai:${id}`)
      .setLabel('Tirar da fila')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger),
  );
}

/**
 * O painel.
 * @param {{selecionado?: string|null, aviso?: string|null}} [opts]
 */
export async function buildQueuePanel({ selecionado = null, aviso = null } = {}) {
  const fila = await filaAtual();
  const app = selecionado ? fila.find((a) => String(a._id) === selecionado) : null;

  const semConvite = fila.filter((a) => a.status !== 'invited').length;
  const embed = {
    title: '📥 Fila de entrada',
    description:
      (aviso ? `${aviso}\n\n` : '') +
      (fila.length
        ? fila.map(linhaFila).join('\n').slice(0, 3800)
        : '_Ninguém aprovado esperando para entrar._'),
    color: 0x2ecc71,
    footer: {
      text: fila.length
        ? `${fila.length} na fila · ${semConvite} sem convite · ordem de aprovação · quem entra sai daqui sozinho`
        : 'Quem entra na guilda sai daqui sozinho.',
    },
  };

  const components = [selectRow(fila, selecionado)];
  if (app) components.push(acoesRow(app));
  components.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${QUEUE_PREFIX}add`)
        .setLabel('Pôr alguém na fila')
        .setEmoji('➕')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`${QUEUE_PREFIX}volta`)
        .setLabel('Atualizar')
        .setEmoji('🔄')
        .setStyle(ButtonStyle.Secondary),
    ),
  );

  return { embeds: [embed], components, ephemeral: true };
}

/** Campo de data reaproveitado pelos dois modais. */
function campoQuando(label) {
  return new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId('quando')
      .setLabel(label)
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setPlaceholder('05/09 ou 05/09 14:30 — vazio = agora'),
  );
}

/** Resolve nick ou ID do Discord, igual ao resto do bot: banco primeiro, API depois. */
async function resolveAlvo(termo) {
  const alvo = String(termo ?? '').trim();
  if (!alvo) return null;

  const porId = alvo.replace(/[<@!>]/g, '');
  if (/^\d{15,}$/.test(porId)) {
    const linked = await collections.members().findOne({ discordId: porId });
    return linked ? { uuid: linked.uuid, username: linked.username, discordId: porId } : null;
  }

  const linked = await collections.members().findOne({ username: new RegExp(`^${alvo}$`, 'i') });
  if (linked) return { uuid: linked.uuid, username: linked.username, discordId: linked.discordId ?? null };
  const player = await wynn.player(alvo).catch(() => null);
  return player?.uuid ? { uuid: player.uuid, username: player.username, discordId: null } : null;
}

/**
 * Roteia todo componente `fila:*`.
 *
 * Toda ação exige staff: a fila decide quem entra na guilda, e a mensagem é
 * efêmera de quem abriu — mas efêmero não é permissão, e quem abriu pode ter
 * perdido o cargo desde então.
 */
export async function handleQueuePanel(interaction, { isStaff }) {
  const id = interaction.customId;
  const [, acao, alvoId] = id.split(':');

  if (!isStaff) {
    const resposta = { content: 'Apenas staff pode mexer na fila de entrada.', ephemeral: true };
    return interaction.isModalSubmit?.() ? interaction.reply(resposta) : interaction.reply(resposta);
  }

  // Modais são respostas por si: não podem vir depois de um defer.
  if (acao === 'inv') {
    return interaction.showModal(
      new ModalBuilder()
        .setCustomId(`${QUEUE_PREFIX}invsave:${alvoId}`)
        .setTitle('Convite enviado')
        .addComponents(campoQuando('Quando o convite foi enviado?')),
    );
  }
  if (acao === 'add') {
    return interaction.showModal(
      new ModalBuilder()
        .setCustomId(`${QUEUE_PREFIX}addsave`)
        .setTitle('Pôr alguém na fila')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('alvo')
              .setLabel('Nick do WynnCraft ou ID do Discord')
              .setStyle(TextInputStyle.Short)
              .setRequired(true),
          ),
          campoQuando('Aprovado quando? (define o lugar na fila)'),
        ),
    );
  }

  await interaction.deferUpdate();

  if (acao === 'invsave') {
    const { at, erro } = parseQuando(interaction.fields.getTextInputValue('quando'));
    if (erro) return interaction.editReply(await buildQueuePanel({ selecionado: alvoId, aviso: `⚠️ ${erro}` }));

    const app = await markInvited(alvoId, { at, by: interaction.user.id });
    if (!app) return interaction.editReply(await buildQueuePanel({ aviso: '⚠️ Não achei essa candidatura.' }));
    audit(
      interaction.client,
      interaction.guildId,
      `✉️ <@${interaction.user.id}> marcou convite enviado para **${app.username}**.`,
    );
    return interaction.editReply(
      await buildQueuePanel({ selecionado: alvoId, aviso: `✉️ Convite de **${app.username}** registrado.` }),
    );
  }

  if (acao === 'addsave') {
    const alvo = await resolveAlvo(interaction.fields.getTextInputValue('alvo'));
    if (!alvo) {
      return interaction.editReply(
        await buildQueuePanel({ aviso: '⚠️ Não achei essa pessoa. Use o nick exato do WynnCraft ou o ID do Discord.' }),
      );
    }
    const { at, erro } = parseQuando(interaction.fields.getTextInputValue('quando'));
    if (erro) return interaction.editReply(await buildQueuePanel({ aviso: `⚠️ ${erro}` }));

    const { app, created } = await addToQueue({ ...alvo, decidedAt: at, by: interaction.user.id });
    if (!created) {
      return interaction.editReply(
        await buildQueuePanel({ selecionado: String(app._id), aviso: `ℹ️ **${app.username}** já estava na fila.` }),
      );
    }
    audit(interaction.client, interaction.guildId, `➕ <@${interaction.user.id}> pôs **${alvo.username}** na fila de entrada.`);
    log.info(`Fila de entrada: ${alvo.username} adicionado manualmente.`);
    return interaction.editReply(
      await buildQueuePanel({ selecionado: String(app._id), aviso: `➕ **${alvo.username}** entrou na fila.` }),
    );
  }

  if (acao === 'sel') {
    return interaction.editReply(await buildQueuePanel({ selecionado: interaction.values?.[0] }));
  }
  if (acao === 'volta') {
    return interaction.editReply(await buildQueuePanel({}));
  }

  const acoes = {
    desinv: [unmarkInvited, '↩️', 'convite desfeito', false],
    sai: [dropFromQueue, '🗑️', 'tirado da fila', true],
  };
  const escolhida = acoes[acao];
  if (!escolhida) return interaction.editReply(await buildQueuePanel({}));

  const [fn, emoji, texto, saiDaFila] = escolhida;
  const app = await fn(alvoId, interaction.user.id);
  if (!app) return interaction.editReply(await buildQueuePanel({ aviso: '⚠️ Não achei essa candidatura.' }));

  audit(interaction.client, interaction.guildId, `${emoji} <@${interaction.user.id}>: **${app.username}** ${texto}.`);
  return interaction.editReply(
    await buildQueuePanel({
      // Quem saiu da fila não pode continuar selecionado: o select nem lista mais.
      selecionado: saiDaFila ? null : alvoId,
      aviso: `${emoji} **${app.username}** — ${texto}.`,
    }),
  );
}
