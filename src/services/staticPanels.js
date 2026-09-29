import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getConfig } from '../config/guildConfig.js';
import { ensurePanel } from './panels.js';
import { logoAttachment, brandWithLogo } from '../util/assets.js';
import { queueStaticPanel } from './recruitQueuePanel.js';

/**
 * @param {Array<{id: string, label: string, emoji: string, style?: import('discord.js').ButtonStyle}>} buttons
 * @returns {ActionRowBuilder}
 */
function row(buttons) {
  return new ActionRowBuilder().addComponents(
    buttons.map((b) =>
      new ButtonBuilder()
        .setCustomId(b.id)
        .setLabel(b.label)
        .setEmoji(b.emoji)
        .setStyle(b.style ?? ButtonStyle.Secondary),
    ),
  );
}

// Painéis de texto fixo, um por canal. O bot mantém UMA mensagem em cada um,
// editando no lugar. Se alguém apagar, o job `panels` republica em até 5 min.
//
// Os textos vieram da staff; só foram ajustados onde o contexto mudou (fila de
// tomes por pontos, empréstimos sem lista de itens, registro pelo botão).

const COLOR = { recruit: 0x3498db, loan: 0xf1c40f, appeal: 0x1abc9c };

/** IDs fixos referenciados nos textos da staff. @type {string} */
const STAFF_ROLE = '1262574400587169863';

// Menções cruas nunca pingam ninguém num painel fixo.
const SILENT = { allowedMentions: { parse: [] } };

function recruitPayload() {
  return {
    ...SILENT,
    embeds: [
      {
        title: '🛡️ Como Entrar na Guilda Wynn Brasil',
        color: COLOR.recruit,
        description:
`Somos uma guilda de **língua portuguesa** — brasileiros, portugueses, angolanos, moçambicanos. Se você fala português, o lugar é aqui.

**Não há requisitos.** Nível, tempo de jogo, build, horário: nada disso entra na conta. Quem quer jogar junto é bem-vindo.

Você já está verificado — seu nick foi confirmado na API oficial quando você se registrou. Faltam dois passos.

**1️⃣ Clique em Enviar candidatura**
> Ela aparece **neste canal**, com uma votação aberta. O placar é público, mas **o voto é anônimo**: ninguém vê quem votou o quê.

**2️⃣ Aceite o convite no jogo**
> Aprovado? Um recrutador te chama. Aceite digitando \`/guild join WnBR\` **dentro do Wynncraft**.

Assim que entrar, o bot te dá o cargo de membro sozinho — em até 10 minutos, sem precisar avisar ninguém — e te manda aqui a lista dos canais que valem a visita.

Dúvidas? Mencione um <@&${STAFF_ROLE}>. Estamos prontos para ajudar.`,
      },
    ],
    components: [
      row([
        { id: 'apply:submit', label: 'Enviar candidatura', emoji: '📨', style: ButtonStyle.Success },
        { id: 'apply:status', label: 'Ver minha candidatura', emoji: '🔍' },
      ]),
    ],
  };
}

// O painel de Tomes é AO VIVO (fila + aspects a entregar) e vive em services/
// tomes.js — não entra na lista de painéis estáticos abaixo.

function loanPayload() {
  return {
    ...SILENT,
    embeds: [
      {
        title: '💰 Empréstimo de Itens',
        color: COLOR.loan,
        description:
`Nosso objetivo é apoiar novos membros, emprestando itens de \`XP Bonus\` e \`Gathering XP\`. São itens caros e difíceis de obter, e disponibilizamos parte dos nossos próprios recursos. Pedimos apenas que sejam devolvidos conforme o combinado.

**Não** emprestamos **Mythics** nem **builds** para lootrun, raid, dungeon ou guerra. O foco é exclusivamente ganho de experiência.

Reservamo-nos o direito de negar empréstimo a jogadores desconhecidos ou inativos. Não leve a mal se ninguém puder confiar em você ainda.

## Regras e Condições
**Solicitação:** peça a qualquer **Chief** ou superior da guilda.

**Responsabilidade:** roubar é passível de banimento no Wynncraft. Ao retirar um item, você se compromete a devolvê-lo no prazo ou pagar o valor acordado.

**Condição:** os itens devem voltar exatamente como saíram.

**Prazo:** todo empréstimo vale **1 semana** por padrão. Devolver antes é sempre bem-vindo.

**Transparência:** seu nome fica na lista de empréstimos até a devolução. O não cumprimento é registrado publicamente, independentemente do motivo.

[**Wynncraft Rules**](https://forums.wynncraft.com/threads/game-forum-rules.111874/#post-3525357) — Seção 7 + Spoiler: *Information about loaning*

-# Cada empréstimo vira um tópico próprio, onde a staff registra os itens. Lembretes automáticos são enviados perto do vencimento e somem deste canal 48h depois da devolução — o tópico fica como registro.`,
      },
    ],
    components: [
      row([
        { id: 'loan:mine', label: 'Meus empréstimos', emoji: '💰', style: ButtonStyle.Primary },
        { id: 'loan:new', label: 'Novo empréstimo', emoji: '📄', style: ButtonStyle.Success },
      ]),
    ],
  };
}

function appealPayload() {
  return {
    ...SILENT,
    embeds: [
      {
        title: '🕊️ Central de Apelações',
        color: COLOR.appeal,
        description:
`Levou uma advertência, suspensão ou expulsão e acha que houve engano? Aqui você pede uma revisão.

**Como funciona**
> **1.** Clique em **Fazer apelação** abaixo.
> **2.** Explique o seu caso na janela que abrir — o mais claro possível.
> **3.** O bot abre um **tópico próprio** para você, onde a staff analisa e responde.

**Bom saber**
> Cada apelação vira um tópico separado, para não se misturar com as outras.
> Traga fatos e contexto. Ofensa ou spam encerram o pedido.
> A decisão final é da <@&${STAFF_ROLE}>.

-# Abrir uma apelação não garante reversão — garante que o seu caso será ouvido.`,
      },
    ],
    components: [
      row([{ id: 'appeal:new', label: 'Fazer apelação', emoji: '🕊️', style: ButtonStyle.Primary }]),
    ],
  };
}

/**
 * key = chave de canal em CHANNEL_KEYS; stateId = documento em watcherState.
 * `build` recebe os parâmetros vigentes, para que nenhum número do texto
 * divirja do que o bot realmente aplica.
 * @type {ReadonlyArray<{key: string, stateId: string, label: string, build: (params: object) => object|Promise<object>}>}
 */
export const PANELS = Object.freeze([
  // As regras da comunidade saíram daqui: vivem em guidelinePanels.js, com as
  // da guilda, do War Team e da Staff, e usam o mesmo `rulesPanel`.
  { key: 'recruiters', stateId: 'recruitPanel', label: 'recrutamento', build: recruitPayload },
  // Segunda mensagem do MESMO canal, logo abaixo. A ordem do array é a ordem
  // em que os painéis nascem, e portanto a ordem deles no canal.
  { key: 'recruiters', stateId: 'recruitQueuePanel', label: 'fila de entrada', build: queueStaticPanel },
  { key: 'loans', stateId: 'loanPanel', label: 'empréstimos', build: loanPayload },
  { key: 'appeals', stateId: 'appealPanel', label: 'apelações', build: appealPayload },
]);

export async function ensureStaticPanels(client, guildDiscordId) {
  const cfg = await getConfig(guildDiscordId);
  for (const p of PANELS) {
    const payload = brandWithLogo(await p.build(cfg.params));
    await ensurePanel(client, cfg.channels?.[p.key], p.stateId, payload, p.label, [logoAttachment()]);
  }
}

export const STATIC_PANEL_IDS = PANELS.map((p) => p.stateId);
