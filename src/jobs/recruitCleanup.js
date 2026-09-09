import { collections } from '../db/mongo.js';
import { log } from '../util/log.js';

// As mensagens de uma candidatura somem 24h depois do VEREDITO — aprovada ou
// rejeitada, tenha a staff clicado em "Convidado" ou não. São duas:
//
//   messageId         — a da votação, que finalizeApplication edita com ✅/❌
//   announceMessageId — o "aprovado" postado no canal dos recrutadores
//
// O corte era `invitedAt`, e isso deixava dois buracos: candidatura REJEITADA
// nunca era limpa (a mensagem ficava para sempre), e a aprovada só começava a
// contar quando alguém lembrava de clicar em "Convidado" — o que podia levar
// dias. Contra `decidedAt` as duas seguem o mesmo relógio.
//
// O painel fixo de recrutamento NÃO é tocado: só as mensagens guardadas por
// candidatura. E o documento em si fica — é dele que sai a fila de aprovados
// que ainda não entraram na guilda, no /verificar.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Apaga uma mensagem, se ela ainda existir. Devolve se apagou. */
async function apagar(client, channelId, messageId) {
  if (!channelId || !messageId) return false;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return false;
  const msg = await channel.messages.fetch(messageId).catch(() => null);
  if (!msg) return false;
  await msg.delete().catch(() => {});
  return true;
}

// As boas-vindas NÃO entram aqui: elas vão no privado da pessoa (ver
// services/recruitWelcome.js), e mensagem de DM é dela — não cabe ao bot decidir
// que a pessoa já leu e apagar.

export async function runRecruitCleanup(client) {
  const cutoff = new Date(Date.now() - MAX_AGE_MS);
  const apps = collections.applications();
  const pending = await apps
    .find({
      // Sem veredito ainda (candidatura aberta) não entra: quem cuida do prazo
      // dessas é o applicationExpiry.
      decidedAt: { $lte: cutoff },
      $or: [
        { messageId: { $exists: true, $ne: null } },
        { announceMessageId: { $exists: true, $ne: null } },
      ],
    })
    .toArray();
  if (!pending.length) return;

  let removed = 0;
  for (const app of pending) {
    if (await apagar(client, app.channelId, app.messageId)) removed += 1;
    if (await apagar(client, app.announceChannelId, app.announceMessageId)) removed += 1;
    // Sempre desmarca, mesmo se a mensagem já não existia — assim o job não
    // reprocessa a mesma candidatura a cada ciclo. Os ids de canal ficam: são
    // baratos e ajudam a staff a rastrear onde a coisa aconteceu.
    await apps.updateOne({ _id: app._id }, { $unset: { messageId: '', announceMessageId: '' } });
  }

  if (removed) log.info(`Recrutamento: ${removed} mensagem(ns) apagada(s) 24h após o veredito.`);
}
