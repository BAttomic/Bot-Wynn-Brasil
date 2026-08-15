import { SlashCommandBuilder } from 'discord.js';
import { optional } from '../../config/env.js';
import { modpackState } from '../../services/modpack.js';

const FABRIC_URL = 'https://fabricmc.net/use/installer/';
const MODRINTH_APP_URL = 'https://modrinth.com/app';

/** Lista "Mod — versão", ou um aviso se o pack ainda não foi gerado. */
function listaDeMods(state) {
  if (!state?.mods?.length) return null;
  return state.mods.map((m) => `• ${m.name} \`${m.version}\``).join('\n');
}

/**
 * Monta a mensagem (efêmera) de download do modpack. Compartilhada pelo comando
 * /modpack e pelo botão "Baixar Modpack" do painel de status.
 *
 * Dois caminhos, e a ordem é a recomendação:
 *
 *  1. `.mrpack` — poucos KB, instalado por launcher (Modrinth App, Prism), e o
 *     launcher passa a oferecer atualização sozinho toda vez que o job regerar o
 *     pack. É o que resolve o problema de gente jogando com mod velho.
 *  2. `.zip` — os jars, para quem não usa launcher alternativo. Sempre a versão
 *     mais recente, mas quem baixa assim tem que baixar de novo na mão.
 *
 * Os dois são servidos por HTTP pelo próprio bot (ver src/health.js), porque o
 * pacote de jars (~32 MB) passa do limite de anexo de bot do Discord (25 MB).
 * Sem PUBLIC_URL, avisa a staff. @returns {import('discord.js').InteractionReplyOptions}
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

  const state = modpackState();
  const mods = listaDeMods(state);
  const fields = [
    {
      name: '🔁 Atualiza sozinho (recomendado)',
      value:
        `**[⬇️ Baixar .mrpack](${base}/modpack.mrpack)** — abra o arquivo no ` +
        `**[Modrinth App](${MODRINTH_APP_URL})** (ou Prism/ATLauncher).\n` +
        'O launcher instala o Fabric e os mods, e avisa quando sair versão nova.',
    },
    {
      name: '📦 Instalação manual',
      value:
        `**[⬇️ Baixar .zip](${base}/modpack)** — precisa do ` +
        `**[Fabric Installer](${FABRIC_URL})**.\n` +
        'Extraia e jogue os `.jar` na pasta `mods`.',
    },
  ];
  if (mods) fields.push({ name: `🧩 No pack (Minecraft ${state.minecraft})`, value: mods });

  return {
    embeds: [
      {
        title: '🇧🇷 Wynn Brasil — Modpack oficial',
        description: 'Os mods são conferidos todo dia: o pack aqui é sempre a versão mais recente.',
        color: 0x2ecc71,
        fields,
        footer: state?.packVersion ? { text: `Versão do pack: ${state.packVersion}` } : undefined,
        timestamp: state?.builtAt,
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
