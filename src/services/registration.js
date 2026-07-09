import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { collections } from '../db/mongo.js';
import { wynn } from '../wynn/api.js';
import { getConfig } from '../config/guildConfig.js';
import { optional } from '../config/env.js';
import { audit } from './audit.js';
import { isHigherRank } from './guildData.js';
import { log } from '../util/log.js';

export const BUTTON_ID = 'registro:verificar';
export const MODAL_ID = 'registro:modal';
export const NICK_FIELD = 'nick';

const PANEL_STATE_ID = 'registrationPanel';
const BLACKLIST_STATE_ID = 'blacklistPanel';

// UUID da guilda é imutável; o prefixo pode ser trocado pelo dono a qualquer
// momento, então ele serve só de fallback. Ambos podem vir do ambiente.
// Lido preguiçosamente porque loadEnv() roda depois da avaliação dos imports.
export function blacklistGuild() {
  return {
    uuid: optional('WYNN_BLACKLIST_GUILD_UUID', 'f7e7cc4e-212d-422f-a3e6-744a8689b108'),
    prefix: optional('WYNN_BLACKLIST_GUILD_PREFIX', 'GsW'),
  };
}

// 'member' = está na nossa guilda | 'banned' = está na guilda da black-list |
// 'neutral' = nenhuma das duas (sem guilda ou em outra qualquer).
export function classifyPlayer(player) {
  const g = player?.guild;
  if (!g) return 'neutral';
  const bl = blacklistGuild();
  if (g.uuid === bl.uuid || g.prefix === bl.prefix) return 'banned';
  const ourUuid = optional('WYNN_GUILD_UUID');
  const ourPrefix = optional('WYNN_GUILD_PREFIX');
  if ((ourUuid && g.uuid === ourUuid) || (ourPrefix && g.prefix === ourPrefix)) return 'member';
  return 'neutral';
}

const ROLE_KEY_BY_KIND = { member: 'guildMember', neutral: 'neutral', banned: 'banned' };

const KIND_LABEL = {
  member: 'Membro da Wynn Brasil',
  neutral: 'Neutro',
  banned: 'BANIDO — membro da Guardians of Wynn',
};

const KIND_COLOR = { member: 0x2ecc71, neutral: 0x95a5a6, banned: 0xe74c3c };

// Garante que o membro tenha EXATAMENTE um dos três cargos de classificação.
// Um banido também perde o cargo de comunidade: o acesso dele é só a black-list.
//
// Os cargos de RANK (Capitão, Estrategista, Sub-líder, Líder) NUNCA entram aqui.
// Eles saem do nick que a pessoa digitou, que ninguém verificou — dar Capitão a
// quem só escreveu o nick de um Capitão seria entregar a guilda. Rank é sempre
// aplicado à mão pela staff; o bot no máximo avisa (ver peakRank em roleSync).
export async function applyClassificationRoles(member, cfg, kind) {
  const wanted = cfg.roles?.[ROLE_KEY_BY_KIND[kind]];

  const toRemove = Object.entries(ROLE_KEY_BY_KIND)
    .filter(([k]) => k !== kind)
    .map(([, key]) => cfg.roles?.[key])
    .filter(Boolean);
  if (kind === 'banned' && cfg.roles?.community) toRemove.push(cfg.roles.community);

  for (const id of toRemove) {
    if (member.roles.cache.has(id)) await member.roles.remove(id).catch(() => {});
  }
  if (wanted && !member.roles.cache.has(wanted)) {
    await member.roles.add(wanted).catch(() => {});
  }
  return wanted;
}

async function notifyRecruiters(client, cfg, { player, kind, discordId }) {
  // Membros da nossa guilda que se registram não são novidade para o recrutamento.
  if (kind === 'member') return;
  const channelId = cfg.channels?.recruiters;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  const title = kind === 'banned' ? '🚫 Registro de membro da GsW' : '🆕 Possível novo membro';
  const guildLine = player.guild
    ? `[${player.guild.prefix}] ${player.guild.name} — ${player.guild.rank}`
    : 'Sem guilda';

  await channel
    .send({
      embeds: [
        {
          title,
          color: KIND_COLOR[kind],
          description:
`**Discord:** <@${discordId}>
**Nick:** \`${player.username}\`
**Guilda atual:** \`${guildLine}\`
**Guerras (conta inteira):** \`${player.globalData?.wars ?? 0}\`
**Nível total:** \`${player.globalData?.totalLevel ?? 0}\``,
          thumbnail: { url: `https://visage.surgeplay.com/bust/350/${player.username}` },
          timestamp: new Date().toISOString(),
        },
      ],
      allowedMentions: { parse: [] },
    })
    .catch(() => {});
}

// Vincula o nick ao Discord de quem clicou e devolve o texto de confirmação
// (a interação já respondeu de forma ephemeral por quem chamou).
export async function linkAndClassify(interaction, rawNick) {
  const nick = rawNick.trim();
  if (!/^\w{1,20}$/.test(nick)) {
    return 'Nick inválido. Use apenas letras, números e `_` (até 20 caracteres).';
  }

  const player = await wynn.player(nick).catch(() => null);
  if (!player || !player.uuid) {
    return `Não encontrei o jogador **${nick}** na API do WynnCraft. Confira a escrita do nick e tente de novo.`;
  }

  const members = collections.members();

  const byUuid = await members.findOne({ uuid: player.uuid });
  if (byUuid && byUuid.discordId !== interaction.user.id) {
    return 'Essa conta do WynnCraft já está vinculada a outro usuário. Fale com a staff se for engano.';
  }

  const byDiscord = await members.findOne({ discordId: interaction.user.id });
  if (byDiscord && byDiscord.uuid !== player.uuid) {
    return `Seu Discord já está vinculado a **${byDiscord.username}**. Peça à staff um \`/unlink\` para trocar.`;
  }

  const kind = classifyPlayer(player);
  const now = new Date();
  // O endpoint de player devolve o rank em MAIÚSCULAS ("OWNER"); o de guilda usa
  // minúsculas. Normalizamos aqui para o resto do bot comparar sem surpresa.
  const rank = player.guild?.rank ? player.guild.rank.toLowerCase() : null;

  const set = {
    uuid: player.uuid,
    discordId: interaction.user.id,
    username: player.username,
    inGuild: kind === 'member',
    guildRank: rank,
    classification: kind,
  };
  if (kind === 'member' && isHigherRank(rank, byUuid?.peakRank)) {
    set.peakRank = rank;
    set.peakRankAt = now;
  }

  await members.updateOne(
    { uuid: player.uuid },
    {
      $set: set,
      $setOnInsert: { linkedAt: now, communitySince: now, guildWars: 0 },
    },
    { upsert: true },
  );

  const cfg = await getConfig(interaction.guildId);
  let roleId = null;
  if (interaction.member?.roles?.add) {
    roleId = await applyClassificationRoles(interaction.member, cfg, kind);
  }

  await notifyRecruiters(interaction.client, cfg, {
    player,
    kind,
    discordId: interaction.user.id,
  });
  await audit(
    interaction.client,
    interaction.guildId,
    `🔗 <@${interaction.user.id}> vinculou **${player.username}** → ${KIND_LABEL[kind]}.`,
  );

  const roleNote = roleId ? ` Cargo <@&${roleId}> aplicado.` : '';
  if (kind === 'banned') {
    const blChannel = cfg.channels?.blacklist;
    return `Conta **${player.username}** vinculada. Você é membro da **Guardians of Wynn**, então recebeu o cargo de banido e só tem acesso a ${blChannel ? `<#${blChannel}>` : 'a black-list'}.${roleNote}`;
  }
  if (kind === 'member') {
    return `Conta **${player.username}** vinculada! Bem-vindo de volta, membro da **Wynn Brasil**.${roleNote}`;
  }
  return `Conta **${player.username}** vinculada! Você entrou como **neutro** — use \`/apply submit\` se quiser entrar na guilda.${roleNote}`;
}

export function panelPayload() {
  return {
    embeds: [
      {
        title: '📋 Registro — Wynn Brasil [WnBR]',
        color: 0x3498db,
        description:
`Para ter acesso ao servidor, vincule sua conta do WynnCraft ao seu Discord.

**Como funciona**
> **1.** Clique no botão **Verificar minha conta** abaixo.
> **2.** Digite o seu nick do WynnCraft na janela que abrir.
> **3.** O bot consulta a API oficial e te entrega o cargo certo.

**Qual cargo você recebe**
> 🟢 Está na **Wynn Brasil** → cargo de membro, acesso completo.
> ⚪ Não está em nenhuma das duas → cargo **neutro**. Pode se candidatar com \`/apply submit\`.
> 🔴 Está na **Guardians of Wynn [GsW]** → cargo de **banido**, acesso apenas à black-list.

-# Só você enxerga a resposta da verificação. Este canal não aceita mensagens.`,
        footer: { text: 'Dados verificados na API oficial do Wynncraft' },
      },
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(BUTTON_ID)
          .setLabel('Verificar minha conta')
          .setEmoji('✅')
          .setStyle(ButtonStyle.Success),
      ),
    ],
  };
}

export function nickModal() {
  return new ModalBuilder()
    .setCustomId(MODAL_ID)
    .setTitle('Verificação de conta')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(NICK_FIELD)
          .setLabel('Seu nick no WynnCraft')
          .setPlaceholder('Ex.: B_Attomic')
          .setStyle(TextInputStyle.Short)
          .setMinLength(1)
          .setMaxLength(20)
          .setRequired(true),
      ),
    );
}

export function blacklistPayload() {
  return {
    embeds: [
      {
        title: '🚫 Você está na black-list',
        color: 0xe74c3c,
        description:
`Sua conta do WynnCraft pertence à guilda **Guardians of Wynn [GsW]**, e por isso você só tem acesso a este canal.

**Não é uma decisão manual.** O bot compara o seu vínculo com a lista de membros da GsW pela API oficial, e refaz essa checagem a cada poucos minutos.

**Como sair daqui**
> Se você deixar a GsW, o bot devolve seu acesso sozinho na próxima checagem — não precisa pedir nada a ninguém.
> Se você não é membro da GsW e mesmo assim caiu aqui, chame a staff: pode ser vínculo errado.`,
        footer: { text: 'Verificado na API oficial do Wynncraft' },
      },
    ],
  };
}

// Publica, reaproveita ou RECRIA a mensagem fixa de um canal. Chamado de tempos
// em tempos: se alguém apagar o painel, ele volta sozinho no próximo ciclo.
async function ensurePanel(client, channelId, stateId, payload, label) {
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
      await msg.edit(payload).catch(() => {});
      return msg.id;
    }
  }

  const msg = await channel.send(payload);
  await state.updateOne(
    { _id: stateId },
    { $set: { messageId: msg.id, channelId: channel.id } },
    { upsert: true },
  );
  log.info(`Painel de ${label} publicado.`);
  return msg.id;
}

export async function ensureRegistrationPanel(client, guildDiscordId) {
  const cfg = await getConfig(guildDiscordId);
  return ensurePanel(client, cfg.channels?.registration, PANEL_STATE_ID, panelPayload(), 'registro');
}

// Garante os dois painéis fixos. Roda periodicamente e logo após /config.
export async function ensurePanels(client, guildDiscordId) {
  const cfg = await getConfig(guildDiscordId);
  await ensurePanel(client, cfg.channels?.registration, PANEL_STATE_ID, panelPayload(), 'registro');
  await ensurePanel(client, cfg.channels?.blacklist, BLACKLIST_STATE_ID, blacklistPayload(), 'black-list');
}

// O canal de registro guarda só a mensagem do painel. Qualquer outra coisa
// postada ali é removida.
export function attachRegistrationGuard(client) {
  client.on('messageCreate', async (message) => {
    if (!message.guildId) return;

    // Nunca apagamos o que nós mesmos postamos. O painel chega aqui pelo evento
    // ANTES de ensurePanel gravar o messageId, então checar o estado salvo faria
    // o guardião apagar o painel recém-criado — e o ciclo se repetiria sem fim.
    if (message.author?.id === client.user?.id) return;

    try {
      const cfg = await getConfig(message.guildId);
      if (message.channelId !== cfg.channels?.registration) return;
      await message.delete().catch(() => {});
    } catch (e) {
      log.error('Falha ao limpar o canal de registro:', e);
    }
  });
}
