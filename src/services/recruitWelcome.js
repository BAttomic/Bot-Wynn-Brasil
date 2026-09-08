import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getConfig } from '../config/guildConfig.js';
import { log } from '../util/log.js';

// Boas-vindas de quem ACABOU de entrar na guilda, no canal de recrutamento — o
// mesmo lugar onde a pessoa se candidatou, então é onde ela ainda está olhando.
//
// São DUAS mensagens, e a divisão é por limitação do Discord: mensagem efêmera
// ("Somente você pode ver isso · Dispensar mensagem") só existe como RESPOSTA a
// uma interação. O bot não tem como mandar uma sozinho, e aqui quem descobre a
// entrada é um job, sem clique nenhum por trás.
//
// Então o canal recebe só o ping — curto, o mínimo para a pessoa ser notificada
// — e o roteiro dos canais vai no efêmero do clique. Quem descarta é o próprio
// Discord, com o botão nativo, e o ping do canal some no mesmo clique.
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

/** O dono vai no customId, e não na menção: menção é texto e pode ser editada. */
function botaoAbrir(discordId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${WELCOME_PREFIX}ver:${discordId}`)
      .setLabel('Ver meus próximos passos')
      .setEmoji('👋')
      .setStyle(ButtonStyle.Success),
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

  // O que fica no canal é só o convite ao clique. O roteiro inteiro aqui seria
  // um paredão de texto no meio das candidaturas de outras pessoas.
  const msg = await canal
    .send({
      content:
        `<@${membro.discordId}> entrou na guilda! 🎉 Clique abaixo para ver seus próximos passos — ` +
        `a resposta aparece **só para você**.`,
      components: [botaoAbrir(membro.discordId)],
      allowedMentions: { users: [membro.discordId] },
    })
    .catch((e) => {
      log.error('Falha ao dar boas-vindas no canal de recrutamento:', e);
      return null;
    });

  return msg?.id ?? null;
}

/**
 * Entrega o roteiro como mensagem EFÊMERA e tira o ping do canal.
 *
 * O efêmero é o "Somente você pode ver isso" nativo: quem descarta é a própria
 * pessoa, pelo botão do Discord, sem o bot precisar de um botão só para isso.
 *
 * O dono sai do customId, e não de quem a mensagem menciona: menção é texto e
 * pode ser editada. Staff também abre — não por precisar do roteiro, mas porque
 * é assim que um ping de alguém que saiu do servidor sai do canal.
 */
export async function handleWelcomeDismiss(interaction, { isStaff = false } = {}) {
  const dono = interaction.customId.split(':')[2];
  if (interaction.user.id !== dono && !isStaff) {
    return interaction.reply({ content: 'Essas boas-vindas não são suas. 🙂', ephemeral: true });
  }

  const { channels } = (await getConfig(interaction.guildId)) ?? {};
  const lista = roteiro(channels ?? {});

  // Responder vem ANTES de apagar: o Discord dá 3 segundos para o clique ser
  // atendido, e apagar a mensagem não conta como resposta.
  await interaction.reply({
    embeds: [
      {
        title: '🎉 Bem-vindo à Wynn Brasil!',
        color: 0x2ecc71,
        description:
          `Você já está na guilda — o cargo de membro entra sozinho.\n\n` +
          `**Passe nesses canais:**\n${lista}`,
      },
    ],
    ephemeral: true,
  });

  // O ping cumpriu o papel de avisar; deixá-lo no canal só acumularia.
  return interaction.message.delete().catch(() => {});
}
