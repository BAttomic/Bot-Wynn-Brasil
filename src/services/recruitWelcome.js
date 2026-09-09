import { log } from '../util/log.js';

// Boas-vindas de quem ACABOU de entrar na guilda, no canal de recrutamento — o
// mesmo lugar onde a pessoa se candidatou, então é onde ela ainda está olhando.
//
// Uma mensagem só, com a menção e o roteiro dos canais. Sem botão: o que a
// pessoa precisa está na tela, e um clique a mais para ler oito linhas é atrito
// sem troca.
//
// O preço de mencionar é ocupar o canal, e quem paga é o recrutamento — que já
// tem candidatura e votação disputando espaço. Por isso a mensagem some sozinha
// depois de 24h (ver jobs/recruitCleanup.js): o aviso serve no dia em que a
// pessoa entra, não na semana seguinte.

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
    ['forum', '💬', 'fórum da comunidade — dúvidas, builds, conversa'],
    ['market', '🪙', 'compra e venda entre membros'],
    ['appeals', '🕊️', 'se algo der errado, é aqui que se resolve'],
  ];
  return guia
    .filter(([key]) => canais?.[key])
    .map(([key, emoji, texto]) => `${emoji} <#${canais[key]}> — ${texto}`)
    .join('\n');
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
 * @returns {Promise<{welcomeMessageId: string, welcomeChannelId: string}|null>}
 *          ids para o job de limpeza achar a mensagem depois
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
            `-# Esta mensagem some sozinha em 24h.`,
        },
      ],
      // Notifica só a pessoa. Sem isto, um `@everyone` que entrasse no texto um
      // dia — por edição ou por nick — pingaria o servidor inteiro.
      allowedMentions: { users: [membro.discordId] },
    })
    .catch((e) => {
      log.error('Falha ao dar boas-vindas no canal de recrutamento:', e);
      return null;
    });

  return msg ? { welcomeMessageId: msg.id, welcomeChannelId: canal.id } : null;
}
