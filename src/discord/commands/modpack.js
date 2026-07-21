import { SlashCommandBuilder } from 'discord.js';
import { optional } from '../../config/env.js';

const FABRIC_URL = 'https://fabricmc.net/use/installer/';

/**
 * Monta a mensagem (efêmera) de download do modpack. Compartilhada pelo comando
 * /modpack e pelo botão "Baixar Modpack" do painel de status.
 *
 * O arquivo (mods.rar, ~27 MB) é grande demais para anexo de bot no Discord
 * (limite de 25 MB), então o bot o serve por HTTP em `${PUBLIC_URL}/modpack`
 * (ver src/health.js) e a mensagem só entrega a URL. Sem PUBLIC_URL, avisa a
 * staff. @returns {import('discord.js').InteractionReplyOptions}
 */
export function modpackReply() {
  const base = optional('PUBLIC_URL', '').replace(/\/+$/, '');
  if (!base) {
    return {
      content:
        '⚠️ O download do modpack ainda não foi configurado. ' +
        'Defina a variável de ambiente `PUBLIC_URL` com o domínio público do bot.',
      ephemeral: true,
    };
  }

  const url = `${base}/modpack`;
  return {
    embeds: [
      {
        title: '🇧🇷 Wynn Brasil — Modpack oficial',
        description:
          `**[⬇️ Baixar modpack](${url})** (mods.rar)\n\n` +
          `Antes de instalar, você **precisa do Fabric Installer**: ` +
          `**[fabricmc.net/use/installer](${FABRIC_URL})**\n\n` +
          'Depois descompacte o `mods.rar` e coloque os arquivos na pasta `mods`.',
        color: 0x2ecc71,
        footer: { text: 'Instale o Fabric, extraia o mods.rar (WinRAR/7-Zip) e jogue na pasta mods.' },
      },
    ],
    ephemeral: true,
  };
}

export default {
  data: new SlashCommandBuilder()
    .setName('modpack')
    .setDescription('Link para baixar o modpack oficial da Wynn Brasil')
    .toJSON(),

  async execute(interaction) {
    return interaction.reply(modpackReply());
  },
};
