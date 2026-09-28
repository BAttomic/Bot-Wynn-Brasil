import { AuditLogEvent, PermissionFlagsBits } from 'discord.js';
import { log } from '../util/log.js';

/**
 * Guarda da hierarquia do servidor.
 *
 * A regra do dono: o Fundador fica no topo, o cargo do bot logo abaixo, e mais
 * ninguém acima do bot. É isso que garante que o bot continue aplicando cargo,
 * apelido e banimento em todo mundo — e que uma troca de dono não tire a guilda
 * das mãos de quem a montou sem que ele fique sabendo.
 *
 * O bot não reage, só avisa: no canal da staff e por DM a quem tem Fundador.
 * Reagir (desfazer, punir) seria apostar que o bot ainda tem poder para isso,
 * e é justamente o poder dele que está em jogo.
 */

const BOT_ROLE = '1554204860138917918'; // Wynn Brasil BOT
const FOUNDER_ROLE = '1268208310423781426'; // Fundador
const ALERT_CHANNEL = '1524911725424414861'; // 🤖・staff-bot

/** Espera antes de conferir: reordenar cargos dispara um evento por cargo movido. */
const DEBOUNCE_MS = 3_000;

/**
 * O que está fora da regra, em frases prontas para o aviso. Recebe dados
 * simples (e não os objetos do discord.js) para dar para testar sem gateway.
 *
 * @param {Array<{id: string, name: string, position: number, permissions: bigint}>} roles
 * @param {boolean} botHasRole  se o membro do bot ainda carrega o cargo dele
 * @returns {string[]}
 */
export function hierarchyProblems(roles, botHasRole) {
  const out = [];
  const byId = new Map(roles.map((r) => [r.id, r]));
  if (!byId.has(FOUNDER_ROLE)) out.push('O cargo **Fundador** não existe mais.');
  const bot = byId.get(BOT_ROLE);
  if (!bot) {
    out.push('O cargo **Wynn Brasil BOT** foi apagado.');
    return out;
  }
  if (!botHasRole) out.push('O bot não tem mais o cargo **Wynn Brasil BOT**.');
  if (!(bot.permissions & PermissionFlagsBits.Administrator)) {
    out.push('O cargo **Wynn Brasil BOT** perdeu a permissão de Administrador.');
  }
  for (const r of roles) {
    if (r.id !== FOUNDER_ROLE && r.id !== BOT_ROLE && r.position > bot.position) {
      out.push(`O cargo **${r.name}** está acima do **Wynn Brasil BOT**.`);
    }
  }
  return out;
}

/** Quem fez a última ação deste tipo, se foi nos últimos segundos. */
async function quemFoi(guild, type, targetId = null) {
  const logs = await guild.fetchAuditLogs({ type, limit: 5 }).catch(() => null);
  const entry = logs?.entries.find(
    (e) => Date.now() - e.createdTimestamp < 60_000 && (!targetId || e.targetId === targetId),
  );
  return entry?.executorId ? ` — por <@${entry.executorId}>` : '';
}

/** Canal da staff + DM a cada Fundador. Nada disso pode derrubar o bot. */
async function alertar(client, guild, titulo, linhas, color = 0xe74c3c) {
  const payload = {
    embeds: [
      {
        title: titulo,
        description: linhas.join('\n'),
        color,
        footer: { text: 'Fundador no topo, Wynn Brasil BOT logo abaixo, mais ninguém acima do bot.' },
        timestamp: new Date().toISOString(),
      },
    ],
    allowedMentions: { parse: [] },
  };
  log.warn(`${titulo}: ${linhas.join(' | ')}`);

  const canal = await client.channels.fetch(ALERT_CHANNEL).catch(() => null);
  if (canal) await canal.send(payload).catch((e) => log.error('Alerta de hierarquia no canal:', e));

  await guild.members.fetch().catch(() => {});
  const fundadores = guild.roles.cache.get(FOUNDER_ROLE)?.members ?? new Map();
  for (const m of fundadores.values()) {
    if (m.user.bot) continue;
    await m.send(payload).catch(() => log.warn(`Não consegui mandar DM de hierarquia para ${m.user.tag}.`));
  }
}

let ultimos = null; // problemas do último aviso; null = ainda não conferido
let timer = null;

async function conferir(client, guildId) {
  const guild = await client.guilds.fetch(guildId);
  const me = await guild.members.fetchMe().catch(() => null);
  const roles = [...guild.roles.cache.values()].map((r) => ({
    id: r.id,
    name: r.name,
    position: r.position,
    permissions: r.permissions.bitfield,
  }));
  const problemas = hierarchyProblems(roles, !!me?.roles.cache.has(BOT_ROLE));

  // Avisa só o que é NOVO: um cargo fora do lugar não gera um aviso a cada
  // evento de cargo, e o boot avisa o que já estava errado uma vez.
  const novos = problemas.filter((p) => !ultimos?.includes(p));
  if (novos.length) {
    const autor = await quemFoi(guild, AuditLogEvent.RoleUpdate);
    await alertar(client, guild, '🛡️ Alerta de hierarquia', [...novos, ...(autor ? [`Última alteração de cargo${autor}.`] : [])]);
  } else if (ultimos?.length && !problemas.length) {
    await alertar(client, guild, '✅ Hierarquia de volta ao normal', ['Nada acima do **Wynn Brasil BOT** além do **Fundador**.'], 0x2ecc71);
  }
  ultimos = problemas;
}

/**
 * Liga os ouvintes. Chamar uma vez, no clientReady.
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 */
export function attachHierarchyGuard(client, guildId) {
  const agendar = () => {
    clearTimeout(timer);
    timer = setTimeout(() => conferir(client, guildId).catch((e) => log.error('Guarda de hierarquia:', e)), DEBOUNCE_MS);
  };

  client.on('roleCreate', (r) => r.guild.id === guildId && agendar());
  client.on('roleUpdate', (_o, r) => r.guild.id === guildId && agendar());
  client.on('roleDelete', (r) => r.guild.id === guildId && agendar());

  client.on('guildMemberUpdate', async (antes, depois) => {
    if (depois.guild.id !== guildId) return;
    if (depois.id === client.user.id) agendar();
    // Sem o estado anterior não dá para dizer o que mudou.
    if (antes.partial) return;
    const tinha = antes.roles.cache.has(FOUNDER_ROLE);
    const tem = depois.roles.cache.has(FOUNDER_ROLE);
    if (tinha === tem) return;
    const autor = await quemFoi(depois.guild, AuditLogEvent.MemberRoleUpdate, depois.id);
    await alertar(client, depois.guild, '🛡️ Cargo Fundador alterado', [
      `<@${depois.id}> ${tem ? 'ganhou' : 'perdeu'} o cargo **Fundador**${autor}.`,
    ]).catch((e) => log.error('Alerta de Fundador:', e));
  });

  client.on('guildUpdate', async (antes, depois) => {
    if (depois.id !== guildId || antes.ownerId === depois.ownerId) return;
    await alertar(client, depois, '🛡️ Posse do servidor transferida', [
      `O dono do servidor passou de <@${antes.ownerId}> para <@${depois.ownerId}>.`,
    ]).catch((e) => log.error('Alerta de posse:', e));
  });

  agendar(); // o que já estava errado antes do boot
}
