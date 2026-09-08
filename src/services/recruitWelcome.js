import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { log } from '../util/log.js';

// Boas-vindas de quem ACABOU de entrar na guilda, postada no canal de
// recrutamento — o mesmo lugar onde a pessoa se candidatou, então é onde ela
// ainda está olhando.
//
// A mensagem menciona a pessoa de propósito: sem ping ela não é avisada, e um
// texto de roteiro de canais que ninguém lê não serve para nada. O preço do ping
// é ocupar o canal, e por isso vem o botão de dispensar.
export const WELCOME_PREFIX = 'bemvindo:';

/**
 * Um canal por linha, só os que existem na configuração.
 *
 * O que o bot não conhece não entra: link quebrado num roteiro de boas-vindas é
 * pior que ausência, porque a pessoa clica, não acontece nada, e a primeira
 * impressão do servidor é de coisa mal cuidada.
 *
 * @param {Record<string, string>} canais  cfg.channels
 */
function roteiro(canais) {
  const guia = [
    ['rules', '📜', 'as regras da comunidade e da guilda — vale a leitura'],
    ['pings', '🔔', 'escolha seus cargos de notificação (guerra, raid, evento)'],
    ['panel', '📊', 'status da guilda ao vivo, ranking e os **seus pontos**'],
    ['tome', '📕', 'fila de tomes e aspects, por ordem de pontuação'],
    ['warApplication', '⚔️', 'como pedir o cargo de guerra'],
    ['events', '🏆', 'eventos de competição e sorteios'],
    ['loans', '💰', 'empréstimos do baú da guilda'],
    ['appeals', '🕊️', 'se algo der errado, é aqui que se resolve'],
  ];
  return guia
    .filter(([key]) => canais?.[key])
    .map(([key, emoji, texto]) => `${emoji} <#${canais[key]}> — ${texto}`)
    .join('\n');
}

/** Só quem foi mencionado (ou a staff) tira a mensagem do canal. */
function botaoDispensar(discordId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${WELCOME_PREFIX}ok:${discordId}`)
      .setLabel('Já li, pode apagar')
      .setEmoji('👍')
      .setStyle(ButtonStyle.Secondary),
  );
}

/**
 * Posta as boas-vindas. Chamada UMA vez, no instante em que o roleSync vê a
 * pessoa aparecer no roster.
 *
 * Falha aqui nunca derruba o ciclo do roleSync: entrar na guilda e receber o
 * cargo é o que importa, e um canal mal configurado não pode travar isso.
 *
 * @param {import('discord.js').Client} client
 * @param {object} cfg                     config da guilda
 * @param {{discordId: string, username: string}} membro
 */
export async function sendGuildWelcome(client, cfg, membro) {
  const canalId = cfg.channels?.recruiters;
  if (!canalId || !membro?.discordId) return null;

  const canal = await client.channels.fetch(canalId).catch(() => null);
  if (!canal) return null;

  const lista = roteiro(cfg.channels);
  const msg = await canal
    .send({
      content: `<@${membro.discordId}>`,
      embeds: [
        {
          title: `🎉 Bem-vindo à Wynn Brasil, ${membro.username}!`,
          color: 0x2ecc71,
          description:
            `Você já está na guilda — o cargo de membro entra sozinho.\n\n` +
            `**Passe nesses canais:**\n${lista}\n\n` +
            `-# Esta mensagem é só sua. Clique no botão abaixo quando terminar de ler.`,
        },
      ],
      components: [botaoDispensar(membro.discordId)],
      allowedMentions: { users: [membro.discordId] },
    })
    .catch((e) => {
      log.error('Falha ao dar boas-vindas no canal de recrutamento:', e);
      return null;
    });

  return msg?.id ?? null;
}

/**
 * Apaga a mensagem a pedido de quem a recebeu.
 *
 * O dono sai do próprio customId, e não de quem a mensagem menciona: a menção é
 * texto e pode ser editada, o customId não. Staff também apaga, senão uma
 * mensagem de alguém que saiu do servidor ficaria presa no canal.
 */
export async function handleWelcomeDismiss(interaction, { isStaff = false } = {}) {
  const dono = interaction.customId.split(':')[2];
  if (interaction.user.id !== dono && !isStaff) {
    return interaction.reply({ content: 'Essas boas-vindas não são suas. 🙂', ephemeral: true });
  }
  // O ack vem ANTES de apagar. Depois de a mensagem sumir não há mais o que
  // responder, e o Discord marca o clique como "Interação falhou" se ninguém
  // respondeu em 3 segundos.
  await interaction.deferUpdate().catch(() => {});
  return interaction.message.delete().catch(() => {});
}
