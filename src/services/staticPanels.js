import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getConfig } from '../config/guildConfig.js';
import { ensurePanel } from './panels.js';

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

const COLOR = { rules: 0x5865f2, guild: 0x2ecc71, pings: 0xe67e22, recruit: 0x3498db, war: 0xe74c3c, tome: 0x9b59b6, loan: 0xf1c40f };

/** IDs fixos referenciados nos textos da staff. @type {string} */
const STAFF_ROLE = '1262574400587169863';
const RECRUIT_CHANNEL = '1309848293278486578';
const BOT_ID = '1285402380648583199';

// Menções cruas nunca pingam ninguém num painel fixo.
const SILENT = { allowedMentions: { parse: [] } };

/** @param {import('../config/guildConfig.js').GuildParams} params */
function rulesPayload(params) {
  const w = params.pointsWeights;
  const base = params.inactivityDays;
  const per = params.inactivityForgivenessPerPoints;
  const maxDays = params.inactivityForgivenessMaxDays;
  const streakPct = Math.round(params.weeklyStreakBonusPerWeek * 100);
  // Exemplo de 10 dias de perdão, escrito a partir do divisor real.
  const exemploPts = per * 10;
  const exemploDias = Math.min(maxDays, 10);
  const exemploTotal = base + exemploDias;
  const fmt = (n) => n.toLocaleString('pt-BR');

  return {
    ...SILENT,
    embeds: [
      {
        title: '📜 Regras da Comunidade Wynn Brasil',
        color: COLOR.rules,
        description:
`Bem-vindo à Wynn Brasil! Aqui, nosso foco é criar um espaço amigável para jogadores de Wynncraft compartilharem informações, dicas e experiências. Para manter esse ambiente saudável, pedimos que todos sigam as regras abaixo:

## 1. Respeito Mútuo
> - Trate todos com respeito. Comportamentos abusivos, discriminatórios ou ofensivos não serão tolerados.
> - Respeite opiniões diferentes e mantenha um diálogo saudável.

## 2. Proibido Conteúdo Ofensivo
> - Não publique ou compartilhe conteúdo inapropriado, incluindo violência gráfica, pornografia ou material discriminatório.
> - Evite linguagem vulgar ou ofensiva.

## 3. Uso Adequado dos Canais e Sem Spam
> - Use os canais para os propósitos definidos.
> - Não envie mensagens repetitivas, desnecessárias ou links externos irrelevantes.
> - Promoção de outros servidores ou autopromoção só é permitida com autorização prévia.
> - Nos canais de voz, mantenha um comportamento respeitoso e evite interrupções.

## 4. Privacidade
> - Respeite a privacidade de outros membros.
> - Não compartilhe ou solicite informações pessoais sem consentimento.

## 5. Comportamento no Jogo
> - Siga as regras oficiais do Wynncraft.
> - Não promova ou participe de trapaças ou exploração de bugs.
> - Seja um bom representante da comunidade dentro e fora do jogo.

## 6. Colaboração e Diversão
> - Participe de forma colaborativa e ajude a manter um ambiente positivo.
> - Lembre-se: estamos aqui para nos divertir e crescer juntos!

### Observações Importantes
- Caso presencie comportamento inadequado, denuncie aos moderadores.
- Violações podem resultar em advertências, suspensões ou banimentos, dependendo da gravidade.
- Escolha seus cargos em <id:customize>. Isso ajuda na organização da guilda e na comunicação sobre eventos.

-# Divirta-se e boas aventuras em Wynncraft!`,
      },
      {
        title: '🛡️ Avisos e Regras da Guilda Wynn Brasil',
        color: COLOR.guild,
        description:
`Nossa guilda segue uma dinâmica simples e inclusiva. Aqui estão os pontos principais para mantermos organização e harmonia:

## 1. Pontos de Contribuição
Tudo que você faz pela guilda vira ponto. Os pontos definem a **fila de Tomes** e a sua **margem de inatividade**.

> \`1.000.000\` de Guild XP → **${w.contribPerMillion} ponto**
> \`1\` Guild Raid → **${w.guildRaid} pontos**, para cada membro do grupo
> \`1\` Guerra → **${w.war} pontos**, multiplicados pelas fronteiras que o defensor tinha
> \`1\` Objetivo Semanal → **${w.weekly} pontos**, +${streakPct}% por semana seguida (até o dobro)

No canal de status da guilda, o botão **Meus pontos** mostra os seus, sua posição e quantos dias de tolerância eles te dão.

## 2. Inatividade e Expulsão
> Membros que ficarem **${base} dias offline** podem ser removidos.
> **Quem contribui ganha margem:** a cada **${fmt(per)} pontos**, você ganha **+1 dia** de perdão, até **+${maxDays} dias**.
> Exemplo: ${fmt(exemploPts)} pontos = ${base} + ${exemploDias} = **${exemploTotal} dias** de tolerância.
> O bot <@${BOT_ID}> calcula isso sozinho. Ninguém precisa pedir: o botão **Meus pontos** te diz quantos dias ainda restam.

**Expulsão por inatividade não é banimento.** Você pode voltar quando quiser, refazendo o processo em <#${RECRUIT_CHANNEL}>.

## 3. Guild Bank
> O Guild Bank é público e aberto para todos. Pegue o que precisar.
> **Scrolls** e **Ferramentas** devem ser devolvidos após o uso. Pegou? Devolva!

## 4. Participação em Atividades da Guilda
Toda atividade abaixo vira ponto, e ponto vira margem de inatividade e prioridade na fila de Tomes.

> **Objetivos Semanais** — a forma mais barata de pontuar. Um objetivo por semana dá \`${w.weekly}\` pontos, e manter a sequência aumenta o valor em ${streakPct}% a cada semana. É o que mais rende por tempo gasto.
> **Guild XP** (\`/guild xp 100\`) — cada \`1.000.000\` vira \`${w.contribPerMillion}\` ponto. Sobe o nível da guilda, o que libera mais membros e slots de baú.
> **Guild Raids** — \`${w.guildRaid}\` pontos para **cada um** dos participantes. Geram buffs e recompensas coletivas.
> **Guerras** — \`${w.war}\` pontos, multiplicados pelas fronteiras que o defensor tinha. Território dá bônus para a guilda inteira.
> **Farm em Grupo** — não pontua, mas rende amizade, dicas e progresso mais rápido.

**Dúvidas ou sugestões?** Procure um membro da <@&${STAFF_ROLE}>. Estamos aqui para ajudar!`,
      },
    ],
  };
}

/**
 * Cargos de auto-role, um grupo por assunto.
 *
 * Um cargo sem ID é simplesmente omitido do painel, em vez de virar uma menção
 * quebrada. É o que permite adicionar um cargo aqui antes de criá-lo no Discord.
 *
 * @typedef {object} PingGroup
 * @property {string}    title
 * @property {string}    [note]   linha de contexto acima da lista
 * @property {string[]}  roles    IDs; entradas vazias são ignoradas
 * @property {string}    [suffix] anotação repetida em CADA linha
 * @type {ReadonlyArray<PingGroup>}
 */
const PING_GROUPS = Object.freeze([
  {
    title: '1. Pings de Experiência (XP)',
    roles: [
      '1268213746585698375',
      '1268211113942847603',
      '1268209833090486423',
      '1268209831219560560',
      '1268209827457400844',
      '1268208726058205245',
      '1268208320452235306',
      '1268208320343445516',
      // TODO: PING XP - BatCave (107+)
      // TODO: PING XP - Fruma Lighthouse (115+)
    ],
  },
  {
    title: '2. Pings de Dungeon',
    roles: [
      '1268218114999586816',
      '1268218115402109049',
      '1268218120196325517',
      '1268218114043019425',
      '1268220280166420572',
      '1268220287510384653',
      '1268220291788574814',
      '1268218121324462226',
      '1268218113137311877',
      '1268218101682405396',
      '1268218112319291462',
    ],
  },
  {
    title: '3. Pings de Profissões',
    note: 'Peça para alguém coletar um recurso ou craftar um item para você.',
    roles: [
      '1331682928979218462',
      '1331682931940528188',
      '1331682925401473095',
      '1331682920431226892',
      '1331682933265793096',
      '1331682936629497907',
      '1331682933655867472',
      '1331682934901444649',
      '1331682934259978445',
      '1331682935937564692',
      '1331682935627190283',
      '1331682937309102191',
    ],
  },
  {
    title: '4. Pings de Quests e Raids',
    note: 'Convide outros membros para participar com você.',
    roles: [
      '1271168738002997279',
      '1269810703972171908',
      '1269810688352718918',
      '1268229834455253013',
      '1268229845398327417',
      '1268229846144647170',
      '1268229847075786853',
      // TODO: PING RAID - The Wartorn Palace (119+)
    ],
  },
  {
    title: '5. Pings de Classes e Eventos',
    note: 'Encontre jogadores da mesma classe ou fique por dentro dos eventos.',
    roles: [
      '1269826644693221466',
      '1269826646886584413',
      '1269826649386385520',
      '1269826651878068374',
      '1269826654381805669',
      '1273252381018165308',
      '1295760021375815701',
    ],
  },
]);

/**
 * Bombas não têm mais cargo de ping. Quem tem Champion enxerga as bombas ativas
 * no jogo, então basta chamar um em vez de manter oito cargos de notificação.
 * @type {string}
 */
const CHAMPION_ROLE = '';

/** Um cargo por linha. `suffix` anota cada linha, não só a última. */
function roleLines(ids, suffix = '') {
  return ids
    .filter(Boolean)
    .map((id) => `<@&${id}>${suffix}`)
    .join('\n');
}

/** @param {PingGroup} g @returns {string} */
function renderGroup(g) {
  const lines = roleLines(g.roles, g.suffix);
  if (!lines) return '';
  return [`**${g.title}**`, g.note, lines].filter(Boolean).join('\n');
}

function pingsPayload() {
  const blocos = PING_GROUPS.map(renderGroup).filter(Boolean);

  // Dois embeds de lista: o Discord corta descrição em 4096 caracteres.
  const meio = Math.ceil(blocos.length / 2);
  const bombas = CHAMPION_ROLE
    ? `\n\n**Bombas ativas**\nNão existe mais cargo de ping para bombas. Chame um <@&${CHAMPION_ROLE}> — quem tem Champion vê no jogo quais bombas estão rodando.`
    : '';

  return {
    ...SILENT,
    embeds: [
      {
        title: '🔔 Auto-Role & Pings: Personalize Suas Notificações',
        color: COLOR.pings,
        description:
`Selecione seus cargos para receber notificações apenas sobre o que interessa a você.

### 📌 Objetivo
> Melhorar a comunicação e a organização da comunidade. Marcando cargos, você recebe ping só dos assuntos que acompanha.

### 📥 Como adquirir cargos?
> Acesse <id:customize> e marque os cargos desejados. Para remover, é só desmarcar no mesmo lugar.

-# ⚠️ Mensagens enviadas neste canal são apagadas automaticamente após 48 horas.`,
      },
      { color: COLOR.pings, description: blocos.slice(0, meio).join('\n\n') },
      { color: COLOR.pings, description: blocos.slice(meio).join('\n\n') + bombas },
    ],
  };
}

function recruitPayload() {
  return {
    ...SILENT,
    embeds: [
      {
        title: '🛡️ Como Entrar na Guilda Wynn Brasil',
        color: COLOR.recruit,
        description:
`Você já está verificado: seu nick foi confirmado na API oficial quando você se registrou. Agora é só se candidatar.

**1️⃣ Sem requisitos obrigatórios**
> Nossa guilda é aberta para toda a comunidade, focada na língua portuguesa. Portugueses, angolanos e latinos em geral também são bem-vindos!

**2️⃣ Clique em Enviar candidatura**
> Ela aparece **neste canal**, com uma votação aberta. O placar é público, mas **o voto é anônimo**: ninguém vê quem votou o quê.

**3️⃣ Aceite o convite**
> Aprovado? Um recrutador te chama no jogo. Aceite digitando \`/guild join WnBR\` **dentro do Wynncraft**.

**4️⃣ Escolha seus cargos**
> Passe em <id:customize> e marque seus interesses. Isso ajuda na sua integração.

Assim que entrar na guilda, o bot te dá o cargo de membro sozinho — em até 10 minutos, sem precisar avisar ninguém.

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

function warApplicationPayload() {
  return {
    ...SILENT,
    embeds: [
      {
        title: '🛡️ Processo de Aplicação para Guerra',
        color: COLOR.war,
        description:
`Se você deseja se juntar ao nosso time de guerra, siga as diretrizes abaixo.

## 🎖️ Cargo de Guerreiro \`WAR\`
> Para fazer parte do exército geral:
> - Ter pelo menos uma classe **nível 120**.
> - Estar disposto a receber PINGs sobre as guerras.

**Os requisitos são simples e servem para garantir um time base ativo!**

## 🏆 Cargo de \`MAIN WAR\`
> Papel mais sério, critérios mais exigentes:

**Atividade e Confiança**
> Seja ativo e conquiste nossa confiança. Builds, estratégias e consumíveis são informação privada. Vazamento resulta em **banimento permanente** da guilda e da comunidade.

**Classe Exclusiva para Guerra**
> Uma classe dedicada só à guerra, pronta a qualquer momento. Trocar de build antes de cada guerra não será bem visto.

**Avaliação da Classe**
> Sua build será avaliada pelo time e pode passar por ajustes. Se você é de confiança e não tem build, nós te passamos uma.

**Acesso Total ao Mapa**
> Sua classe de guerra precisa ter todas as regiões desbloqueadas (quests completas), para atuar em qualquer lugar.

**Função na Guerra**
> Após a aprovação você será designado a uma ou mais funções: \`DPS\`, \`HEALER\` ou \`TANK\`.

## 📩 Como se candidatar?
> Clique em **Candidatar-se** abaixo e preencha classe, interesse e função. Sua aplicação vai direto para a staff.

-# 🔔 Não atingiu os critérios do cargo principal? Você ainda pode entrar no exército geral.`,
      },
    ],
    components: [
      row([{ id: 'war:apply', label: 'Candidatar-se', emoji: '⚔️', style: ButtonStyle.Danger }]),
    ],
  };
}

function tomePayload() {
  return {
    ...SILENT,
    embeds: [
      {
        title: '📜 Distribuição de Tomes',
        color: COLOR.tome,
        description:
`Regras e requisitos para receber o **Guild Tome**.

### Requisitos
> Ter pelo menos uma classe de nível \`120\`.
> Ter completado a quest \`Realm of Light I - The Worm Holes\`.
> Ser membro da guilda há pelo menos \`1 semana\`.

Todos são exigências do próprio jogo para usar Tomes de Guilda.

### Como a guilda consegue Tomes?
> **Buff de Território** — territórios conquistados em guerra (\`/guild attack\`) podem ter o buff *Tome Seeking*, que dá chance de encontrar Tomes exclusivos por hora.
> **Objetivos Semanais** — as missões semanais dão um baú de recompensas com Tome, além de Banner Points, esmeraldas e Guild XP.
> **Recompensa de Season** — territórios geram \`Season Rating\` por hora, e a temporada paga recompensas ao final.

### Como solicito meu Tome?
Clique em **Entrar na fila** abaixo. O botão já te diz sua posição.

**A fila é ordenada por pontos de contribuição**, não por ordem de chegada. Guerras, guild raids, objetivos semanais e Guild XP contam — quem mais ajuda a guilda recebe primeiro.

Mesmo que seu Tome tenha atributos baixos, aguarde **30 dias** após receber um antes de pedir outro. Outros membros também precisam.

-# Para receber, vá em Bússola ➜ Bandeira ➜ Chave ➜ Maçã Dourada.`,
      },
    ],
    components: [
      row([
        { id: 'tome:join', label: 'Entrar na fila', emoji: '📜', style: ButtonStyle.Success },
        { id: 'tome:leave', label: 'Sair da fila', emoji: '🚪', style: ButtonStyle.Danger },
        { id: 'tome:queue', label: 'Ver fila', emoji: '📋' },
        { id: 'tome:deliver', label: 'Entregar Tome', emoji: '🎁', style: ButtonStyle.Primary },
      ]),
    ],
  };
}

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

-# Cada empréstimo vira um tópico próprio, onde a staff registra os itens. Lembretes automáticos são enviados perto do vencimento.`,
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

/**
 * key = chave de canal em CHANNEL_KEYS; stateId = documento em watcherState.
 * `build` recebe os parâmetros vigentes, para que nenhum número do texto
 * divirja do que o bot realmente aplica.
 * @type {ReadonlyArray<{key: string, stateId: string, label: string, build: (params: object) => object}>}
 */
export const PANELS = Object.freeze([
  { key: 'rules', stateId: 'rulesPanel', label: 'regras', build: rulesPayload },
  { key: 'pings', stateId: 'pingsPanel', label: 'pings', build: pingsPayload },
  { key: 'recruiters', stateId: 'recruitPanel', label: 'recrutamento', build: recruitPayload },
  { key: 'warApplication', stateId: 'warApplicationPanel', label: 'aplicação war', build: warApplicationPayload },
  { key: 'tome', stateId: 'tomePanel', label: 'tomes', build: tomePayload },
  { key: 'loans', stateId: 'loanPanel', label: 'empréstimos', build: loanPayload },
]);

export async function ensureStaticPanels(client, guildDiscordId) {
  const cfg = await getConfig(guildDiscordId);
  for (const p of PANELS) {
    await ensurePanel(client, cfg.channels?.[p.key], p.stateId, p.build(cfg.params), p.label);
  }
}

export const STATIC_PANEL_IDS = PANELS.map((p) => p.stateId);

export const PINGS_STATE_ID = 'pingsPanel';
