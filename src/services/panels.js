import { collections } from '../db/mongo.js';
import { log } from '../util/log.js';

// Publica, reaproveita ou RECRIA a mensagem fixa de um canal. Chamado de tempos
// em tempos: se alguém apagar o painel, ele volta sozinho no próximo ciclo.
//
// Se a mensagem ainda existe, é editada no lugar — o texto fica sempre atual sem
// duplicar nem empurrar a mensagem para baixo do canal.
export async function ensurePanel(client, channelId, stateId, payload, label, files = []) {
  if (!channelId) return null;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    log.warn(`Canal de ${label} configurado mas inacessível.`);
    return null;
  }

  const state = collections.watcherState();
  const saved = await state.findOne({ _id: stateId });

  if (saved?.messageId && saved.channelId === channel.id) {
    const msg = await channel.messages.fetch(saved.messageId).catch(() => null);
    if (msg) {
      // SEMPRE edita no lugar — nunca reenvia (reenviar jogaria o painel para o
      // fim do canal). Se a mensagem antiga ainda não tem o anexo do logo,
      // incluímos o arquivo NESTA edição (o Discord anexa). As edições seguintes
      // omitem o arquivo e o Discord preserva o anexo, sem reenviar nada.
      const needsFiles = files.length && msg.attachments.size === 0;
      await msg.edit(needsFiles ? { ...payload, files } : payload).catch(() => {});
      return msg.id;
    }
  }

  const msg = await channel.send(files.length ? { ...payload, files } : payload);
  await state.updateOne(
    { _id: stateId },
    { $set: { messageId: msg.id, channelId: channel.id } },
    { upsert: true },
  );
  log.info(`Painel de ${label} publicado.`);
  return msg.id;
}

export async function panelMessageId(stateId) {
  const doc = await collections.watcherState().findOne({ _id: stateId });
  return doc?.messageId ?? null;
}
