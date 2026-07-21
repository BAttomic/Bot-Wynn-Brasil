import { REST, Routes } from 'discord.js';
import { required } from '../config/env.js';
import { reportError } from '../services/errorReport.js';
import { log } from '../util/log.js';

import link from './commands/link.js';
import unlink from './commands/unlink.js';
import config from './commands/config.js';
import apply from './commands/apply.js';
import season from './commands/season.js';
import leaderboard from './commands/leaderboard.js';
import profile from './commands/profile.js';
import war from './commands/war.js';
import tome from './commands/tome.js';
import loan from './commands/loan.js';
import calc from './commands/calc.js';
import points from './commands/points.js';
import verificar from './commands/verificar.js';
import membros from './commands/membros.js';
import registro from './commands/registro.js';
import missao from './commands/missao.js';
import ban from './commands/ban.js';
import forcelink from './commands/forcelink.js';
import uniforme from './commands/uniforme.js';
import modpack from './commands/modpack.js';
import booth from './commands/booth.js';

const commands = [link, unlink, config, apply, season, leaderboard, profile, war, tome, loan, calc, points, verificar, membros, registro, missao, ban, forcelink, uniforme, modpack, booth];
const byName = new Map(commands.map((c) => [c.data.name, c]));

export async function registerCommands() {
  const token = required('DISCORD_TOKEN');
  const clientId = required('DISCORD_CLIENT_ID');
  const guildId = required('DISCORD_GUILD_ID');
  const rest = new REST({ version: '10' }).setToken(token);
  // Registro por-guilda: aparece na hora (sem espera de propagação global).
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: commands.map((c) => c.data),
  });
  log.info(`Slash commands registrados: ${commands.map((c) => c.data.name).join(', ')}`);
}

/**
 * Responde a uma interação que já pode (ou não) ter sido deferida.
 * Sem isto, uma interação sem resposta vira "Interação falhou" no cliente.
 * @param {import('discord.js').Interaction} interaction
 * @param {string} content
 * @returns {Promise<void>}
 */
async function safeReply(interaction, content) {
  if (!interaction.isRepliable?.()) return;
  const payload = { content, ephemeral: true };
  const p = interaction.deferred || interaction.replied
    ? interaction.followUp(payload)
    : interaction.reply(payload);
  await p.catch(() => {});
}

/** @param {import('discord.js').Interaction} interaction */
function ownerOf(interaction) {
  for (const c of commands) {
    if (typeof c.handleComponent !== 'function') continue;
    // Um `owns` mal escrito não pode derrubar o roteamento inteiro.
    try {
      if (c.owns?.(interaction)) return c;
    } catch (e) {
      log.error(`owns() de /${c.data.name} lançou:`, e);
    }
  }
  return null;
}

export function attachHandlers(client, ctx) {
  client.on('interactionCreate', async (interaction) => {
    // Botões, menus e modais são roteados para o comando "dono".
    if (!interaction.isChatInputCommand()) {
      if (interaction.isAutocomplete?.()) return; // não é componente

      const owner = ownerOf(interaction);
      if (!owner) {
        log.warn(`Componente sem dono: ${interaction.customId}`);
        await safeReply(interaction, 'Este botão não responde mais. Use o comando equivalente.');
        return;
      }
      try {
        await owner.handleComponent(interaction, ctx);
      } catch (e) {
        log.error(`Erro no componente ${interaction.customId}:`, e);
        reportError(`Componente ${interaction.customId}`, e);
        await safeReply(interaction, 'Ocorreu um erro ao processar sua ação.');
      }
      return;
    }

    const cmd = byName.get(interaction.commandName);
    if (!cmd) return;
    try {
      await cmd.execute(interaction, ctx);
    } catch (e) {
      log.error(`Erro no comando ${interaction.commandName}:`, e);
      reportError(`Comando /${interaction.commandName}`, e);
      const msg = { content: 'Ocorreu um erro ao executar o comando.', ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(msg).catch(() => {});
      } else {
        await interaction.reply(msg).catch(() => {});
      }
    }
  });
}
