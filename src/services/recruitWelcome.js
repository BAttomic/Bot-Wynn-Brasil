import { log } from '../util/log.js';

// Boas-vindas de quem ACABOU de entrar na guilda: o roteiro dos canais, no
// PRIVADO da pessoa.
//
// A DM resolve de uma vez o que o canal não resolvia. É mesmo só dela, não ocupa
// espaço de ninguém, e fica guardada para reler — o roteiro de um servidor é
// exatamente o tipo de coisa que se procura de novo uma semana depois.
//
// Efêmero seria o formato ideal ("Só você pode ver esta mensagem"), mas o
// Discord só o entrega como RESPOSTA a uma interação, e quem descobre a entrada
// aqui é um job, sem clique por trás. Um botão só para gerar essa interação
// cobraria da pessoa um clique para ler o que já estaria pronto.
//
// Com DM fechada — comum — cai no canal de recrutamento, mencionando. É a única
// boa-vinda que a pessoa recebe; ficar em silêncio seria pior que ocupar espaço.

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
    // Apelação fica de fora de propósito: é o canal de quem foi punido, e falar
    // disso na primeira mensagem que a pessoa recebe começa a relação pelo pior
    // lado. Quem precisar dele vai ser levado até lá por quem aplicou a punição.
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
 * @returns {Promise<boolean>} se a pessoa foi avisada, por DM ou pelo canal
 */
export async function sendGuildWelcome(client, cfg, membro) {
  if (!membro?.discordId) return null;

  const corpo = (aviso) => ({
    embeds: [
      {
        title: `🎉 Bem-vindo à Wynn Brasil, ${membro.username}!`,
        color: 0x2ecc71,
        description:
          `Você já está na guilda — o cargo de membro entra sozinho.\n\n` +
          `**Passe nesses canais:**\n${roteiro(cfg.channels)}` +
          (aviso ? `\n\n${aviso}` : ''),
      },
    ],
  });

  // PRIMEIRO no privado. É o único lugar onde a mensagem é mesmo só da pessoa,
  // ela pode reler quando quiser, e o canal de recrutamento não paga o preço.
  const user = await client.users.fetch(membro.discordId).catch(() => null);
  if (user) {
    const dm = await user.send(corpo()).catch(() => null);
    if (dm) return true;
  }

  // DM fechada é comum, e ficar em silêncio seria perder a única boa-vinda que a
  // pessoa recebe. Então cai no canal, mencionando.
  const canalId = cfg.channels?.recruiters;
  if (!canalId) return false;
  const canal = await client.channels.fetch(canalId).catch(() => null);
  if (!canal) return false;

  const msg = await canal
    .send({
      content: `<@${membro.discordId}>`,
      ...corpo('-# Não consegui te chamar no privado, então deixei aqui.'),
      // Notifica só a pessoa. Sem isto, um `@everyone` que entrasse no texto um
      // dia — por edição ou por nick — pingaria o servidor inteiro.
      allowedMentions: { users: [membro.discordId] },
    })
    .catch((e) => {
      log.error('Falha ao dar boas-vindas no canal de recrutamento:', e);
      return null;
    });

  return !!msg;
}
