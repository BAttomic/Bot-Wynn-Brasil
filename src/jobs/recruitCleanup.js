import { collections } from '../db/mongo.js';
import { log } from '../util/log.js';

// Anúncio de "novo recruta aprovado" some 24h depois de a staff clicar em
// "Convidado". O painel fixo de recrutamento NÃO é tocado: apagamos só as
// mensagens que guardamos por candidatura (announceMessageId).
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export async function runRecruitCleanup(client) {
  const cutoff = new Date(Date.now() - MAX_AGE_MS);
  const apps = collections.applications();
  const pending = await apps
    .find({
      status: 'invited',
      invitedAt: { $lte: cutoff },
      announceMessageId: { $exists: true, $ne: null },
    })
    .toArray();
  if (!pending.length) return;

  let removed = 0;
  for (const app of pending) {
    const channel = await client.channels.fetch(app.announceChannelId).catch(() => null);
    if (channel) {
      const msg = await channel.messages.fetch(app.announceMessageId).catch(() => null);
      if (msg) {
        await msg.delete().catch(() => {});
        removed += 1;
      }
    }
    // Sempre desmarca, mesmo se a mensagem já não existia — assim o job não
    // reprocessa a mesma candidatura a cada ciclo.
    await apps.updateOne(
      { _id: app._id },
      { $unset: { announceMessageId: '', announceChannelId: '' } },
    );
  }

  if (removed) log.info(`Canal de recrutamento: ${removed} anúncio(s) de convite apagado(s) após 24h.`);
}
