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
import { findBan, recordBan, BAN_REASON_BLACKLIST_GUILD } from './bans.js';
import { ensurePanel } from './panels.js';
import { logoAttachment, brandWithLogo } from '../util/assets.js';
import { log } from '../util/log.js';

export const BUTTON_ID = 'registro:verificar';
export const MODAL_ID = 'registro:modal';
export const NICK_FIELD = 'nick';

const PANEL_STATE_ID = 'registrationPanel';

// Canais citados no painel de registro. Mention <#id> aponta para o canal e
// nunca pinga ninguém. IDs fixos, no mesmo espírito de staticPanels.js.
const RECRUIT_CHANNEL = '1309848293278486578';
const STATUS_CHANNEL = '1524920847637155861';

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

// Cargos que cada classificação DEVE ter. O membro da guilda também é da
// comunidade — a recíproca não vale: o neutro tem só o de comunidade.
const ROLES_BY_KIND = {
  member: ['guildMember', 'community'],
  neutral: ['community'],
  banned: [],
};

const ALL_CLASSIFICATION_KEYS = ['guildMember', 'community', 'banned'];

const KIND_LABEL = {
  member: 'Membro da Wynn Brasil',
  neutral: 'Neutro',
};

// Garante que o membro tenha EXATAMENTE um dos três cargos de classificação.
// Um banido também perde o cargo de comunidade: o acesso dele é só a black-list.
//
// Os cargos de RANK (Capitão, Estrategista, Sub-líder, Líder) NUNCA entram aqui.
// Eles saem do nick que a pessoa digitou, que ninguém verificou — dar Capitão a
// quem só escreveu o nick de um Capitão seria entregar a guilda. Rank é sempre
// aplicado à mão pela staff; o bot no máximo avisa (ver peakRank em roleSync).
export async function applyClassificationRoles(member, cfg, kind) {
  const wantedKeys = ROLES_BY_KIND[kind] ?? [];
  const wantedIds = wantedKeys.map((k) => cfg.roles?.[k]).filter(Boolean);

  // O banido fica sem nenhum dos três: o cargo de banido é aplicado à parte
  // (abaixo) e o acesso dele vem só do override de canal na black-list.
  const bannedId = cfg.roles?.banned;
  const removeIds = ALL_CLASSIFICATION_KEYS.map((k) => cfg.roles?.[k])
    .filter(Boolean)
    .filter((id) => !wantedIds.includes(id) && !(kind === 'banned' && id === bannedId));

  for (const id of removeIds) {
    if (member.roles.cache.has(id)) await member.roles.remove(id).catch(() => {});
  }
  if (kind === 'banned' && bannedId && !member.roles.cache.has(bannedId)) {
    await member.roles.add(bannedId).catch(() => {});
  }
  for (const id of wantedIds) {
    if (!member.roles.cache.has(id)) await member.roles.add(id).catch(() => {});
  }

  return kind === 'banned' ? bannedId : wantedIds[0] ?? null;
}

// Deixa o apelido no Discord igual ao nick do WynnCraft.
//
// Falha silenciosamente em dois casos que o Discord não deixa contornar: o dono
// do servidor nunca pode ser renomeado por um bot, e nem quem tem cargo acima do
// cargo do bot. Não é erro do registro, então não atrapalha o resto.
export async function syncNickname(member, username) {
  if (!member?.manageable) return false;
  if (member.nickname === username) return true;
  const ok = await member.setNickname(username).then(() => true).catch(() => false);
  if (!ok) log.warn(`Não consegui renomear ${member.user?.tag ?? member.id} para "${username}".`);
  return ok;
}

// Só o registro de um NEUTRO vira aviso: é um recruta em potencial.
//
// Vai para `recruitAlerts`, um canal de staff — e não para o de recrutamento,
// que é público e onde o próprio candidato está lendo o painel. Sem esse canal
// configurado, cai no log de auditoria.
//
// Um banido não gera mensagem nenhuma, em canal nenhum. Basta um print vazar
// para a regra da black-list virar pública, e aí quem é da guilda proibida passa
// a saber que precisa sair dela antes de se registrar.
async function notifyRecruitAlert(client, cfg, { player, kind, discordId }) {
  if (kind !== 'neutral') return;
  const channelId = cfg.channels?.recruitAlerts ?? cfg.channels?.logs;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  const guildLine = player.guild
    ? `[${player.guild.prefix}] ${player.guild.name} — ${player.guild.rank}`
    : 'Sem guilda';

  await channel
    .send({
      embeds: [
        {
          title: '🆕 Possível novo membro',
          color: 0x95a5a6,
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

/**
 * Núcleo do vínculo, agnóstico de quem disparou. Escreve o vínculo, aplica
 * classificação/cargo/apelido e devolve o resultado — sem texto de UI.
 *
 * @param {object} args
 * @param {import('discord.js').Client}       args.client
 * @param {string}                            args.guildId
 * @param {string}                            args.targetDiscordId  dono do vínculo
 * @param {import('discord.js').GuildMember?} args.targetMember     para aplicar cargo/apelido
 * @param {string}                            args.rawNick
 * @param {string?}                           [args.actorId]  quem forçou (staff), se houver
 * @param {boolean}                           [args.force]    sobrescreve vínculos conflitantes
 * @returns {Promise<{ok: boolean, error?: string, kind?: string, roleId?: string|null, player?: object, replaced?: object|null}>}
 */
async function performLink({ client, guildId, targetDiscordId, targetMember, rawNick, actorId, force = false }) {
  const nick = rawNick.trim();
  if (!/^\w{1,20}$/.test(nick)) {
    return { ok: false, error: 'Nick inválido. Use apenas letras, números e `_` (até 20 caracteres).' };
  }

  const player = await wynn.player(nick).catch(() => null);
  if (!player || !player.uuid) {
    return { ok: false, error: `Não encontrei o jogador **${nick}** na API do WynnCraft. Confira a escrita do nick.` };
  }

  const members = collections.members();
  const byUuid = await members.findOne({ uuid: player.uuid });
  const byDiscord = await members.findOne({ discordId: targetDiscordId });

  // Conflitos: no fluxo normal são erro; no forçado, a staff assume e sobrescreve.
  if (byUuid && byUuid.discordId !== targetDiscordId && !force) {
    return { ok: false, error: 'Essa conta do WynnCraft já está vinculada a outro usuário. Fale com a staff se for engano.' };
  }
  if (byDiscord && byDiscord.uuid !== player.uuid && !force) {
    return { ok: false, error: `Seu Discord já está vinculado a **${byDiscord.username}**. Peça à staff um \`/unlink\` para trocar.` };
  }

  // Ao forçar sobre conflitos, apaga os vínculos antigos para não colidir com os
  // índices únicos (uuid, discordId) na hora do upsert.
  const replaced = [];
  if (force) {
    if (byUuid && byUuid.discordId !== targetDiscordId) replaced.push(byUuid);
    if (byDiscord && byDiscord.uuid !== player.uuid) replaced.push(byDiscord);
    for (const doc of replaced) await members.deleteOne({ _id: doc._id });
  }

  // A lista de banidos vem antes da guilda: quem já foi banido continua banido,
  // mesmo que hoje esteja sem guilda ou dentro da nossa. E cada tentativa reforça
  // o par (uuid, discord), então trocar de conta ou de Discord só amplia a teia.
  const priorBan = await findBan({ uuid: player.uuid, discordId: targetDiscordId });
  let kind = classifyPlayer(player);
  if (priorBan || kind === 'banned') {
    kind = 'banned';
    await recordBan({
      uuid: player.uuid,
      username: player.username,
      discordId: targetDiscordId,
      reason: priorBan?.reason ?? BAN_REASON_BLACKLIST_GUILD,
    });
  }

  const now = new Date();
  // O endpoint de player devolve o rank em MAIÚSCULAS ("OWNER"); o de guilda usa
  // minúsculas. Normalizamos aqui para o resto do bot comparar sem surpresa.
  const rank = player.guild?.rank ? player.guild.rank.toLowerCase() : null;

  const set = {
    uuid: player.uuid,
    discordId: targetDiscordId,
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
    { $set: set, $setOnInsert: { linkedAt: now, communitySince: now, guildWars: 0 } },
    { upsert: true },
  );

  const cfg = await getConfig(guildId);
  let roleId = null;
  if (targetMember?.roles?.add) {
    roleId = await applyClassificationRoles(targetMember, cfg, kind);
    await syncNickname(targetMember, player.username);
  }

  await notifyRecruitAlert(client, cfg, { player, kind, discordId: targetDiscordId });

  // Banimento não deixa rastro no log: o canal tem leitores demais.
  if (kind !== 'banned') {
    const quem = actorId
      ? `🔗 <@${actorId}> vinculou **forçadamente** <@${targetDiscordId}> → **${player.username}** (${KIND_LABEL[kind]}).`
      : `🔗 <@${targetDiscordId}> vinculou **${player.username}** → ${KIND_LABEL[kind]}.`;
    await audit(client, guildId, quem);
  }

  return { ok: true, kind, roleId, player, replaced: replaced[0] ?? null };
}

// Vincula o nick ao Discord de quem clicou e devolve o texto de confirmação
// (a interação já respondeu de forma ephemeral por quem chamou).
export async function linkAndClassify(interaction, rawNick) {
  const res = await performLink({
    client: interaction.client,
    guildId: interaction.guildId,
    targetDiscordId: interaction.user.id,
    targetMember: interaction.member,
    rawNick,
  });
  if (!res.ok) return res.error;

  // O banimento é SILENCIOSO: confirmação comum, sem citar cargo, GsW ou motivo,
  // e sem sugerir candidatura, que só chamaria atenção.
  const roleNote = res.roleId && res.kind !== 'banned' ? ` Cargo <@&${res.roleId}> aplicado.` : '';
  if (res.kind === 'banned') {
    return `Conta **${res.player.username}** vinculada com sucesso!`;
  }
  if (res.kind === 'member') {
    return `Conta **${res.player.username}** vinculada! Bem-vindo de volta, membro da **Wynn Brasil**.${roleNote}`;
  }
  return `Conta **${res.player.username}** vinculada! Quer entrar na guilda? Vá ao canal de recrutamento e clique em **Enviar candidatura**.${roleNote}`;
}

/**
 * Vínculo forçado pela staff: registra `targetDiscordId` na conta `rawNick`,
 * sobrescrevendo vínculos conflitantes. Devolve um resumo para a staff.
 * @returns {Promise<string>}
 */
export async function forceLink({ interaction, targetUser, targetMember, rawNick }) {
  const res = await performLink({
    client: interaction.client,
    guildId: interaction.guildId,
    targetDiscordId: targetUser.id,
    targetMember,
    rawNick,
    actorId: interaction.user.id,
    force: true,
  });
  if (!res.ok) return res.error;

  const linhas = [
    `Vínculo forçado: <@${targetUser.id}> → **${res.player.username}**.`,
    `Classificação: **${KIND_LABEL[res.kind] ?? 'BANIDO'}**${res.roleId && res.kind !== 'banned' ? ` · cargo <@&${res.roleId}> aplicado` : ''}.`,
  ];
  if (res.replaced) {
    linhas.push(`⚠️ Substituiu o vínculo anterior de **${res.replaced.username}** (<@${res.replaced.discordId}>).`);
  }
  if (!targetMember) {
    linhas.push('⚠️ O usuário não está no servidor, então nenhum cargo foi aplicado — só o registro no banco.');
  }
  return linhas.join('\n');
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
> ⚪ Não está na guilda → cargo de comunidade. Depois é só clicar em **Enviar candidatura** em <#${RECRUIT_CHANNEL}>.

**O que o bot passa a rastrear**
> Seu apelido no Discord vira o seu nick, e se atualiza sozinho caso você troque de nome no jogo.
> Guild XP, guerras, guild raids e objetivos semanais viram **pontos de contribuição**, que definem a fila de Tomes e a sua margem de inatividade. O botão **Meus pontos**, em <#${STATUS_CHANNEL}>, mostra os seus.

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

export async function ensureRegistrationPanel(client, guildDiscordId) {
  const cfg = await getConfig(guildDiscordId);
  return ensurePanel(client, cfg.channels?.registration, PANEL_STATE_ID, brandWithLogo(panelPayload()), 'registro', [logoAttachment()]);
}

// Garante o painel fixo do registro. Roda periodicamente e logo após /config.
//
// A black-list NÃO recebe painel: qualquer texto ali entregaria que existe uma
// regra automática contra a GsW. O canal fica mudo de propósito.
export async function ensurePanels(client, guildDiscordId) {
  const cfg = await getConfig(guildDiscordId);
  await ensurePanel(client, cfg.channels?.registration, PANEL_STATE_ID, brandWithLogo(panelPayload()), 'registro', [logoAttachment()]);
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
