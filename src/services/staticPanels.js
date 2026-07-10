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

const STAFF_ROLE = '1262574400587169863';
const MEMBER_ROLE = '1262796467488165908';
const RECRUIT_CHANNEL = '1309848293278486578';
const BOT_ID = '1285402380648583199';

// Menções cruas nunca pingam ninguém num painel fixo.
const SILENT = { allowedMentions: { parse: [] } };

function rulesPayload() {
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

## 1. Inatividade e Expulsão
> - Usamos o bot <@${BOT_ID}> para monitorar registros de inatividade.
> - Membros que ficarem **7 dias offline** serão removidos, exceto em casos específicos:
>   - Para cada **100 milhões de Guild XP** farmados, você ganha **+1 dia** de margem.
>   - Exemplo: farmou 1 bilhão de XP? São 7 dias + 10 dias extras de perdão.
> - **Expulsão por inatividade não é banimento.** Você pode voltar quando quiser, refazendo o processo em <#${RECRUIT_CHANNEL}>.

## 2. Guild Bank
> - O Guild Bank é público e aberto para todos. Pegue o que precisar, mas observe:
>   - **Scrolls** e **Ferramentas** devem ser devolvidos após o uso.
>   - Pegou? Certifique-se de devolver!

## 3. Participação em Atividades da Guilda
> - **Raids de Guilda:** geram benefícios coletivos para toda a guilda, como buffs e recompensas compartilhadas.
> - **Guerras de Guilda:** melhoram o ranking e garantem territórios, que dão bônus a todos os membros.
> - **Farm em Grupo:** aumenta a interação, acelera o progresso e rende troca de dicas.

**Dúvidas ou sugestões?** Procure um membro da <@&${STAFF_ROLE}>. Estamos aqui para ajudar!`,
      },
    ],
  };
}

function pingsPayload() {
  const xp = ['1268213746585698375', '1268211113942847603', '1268209833090486423', '1268209831219560560', '1268209827457400844', '1268208726058205245', '1268208320452235306', '1268208320343445516'];
  const dungeon = ['1268218114999586816', '1268218115402109049', '1268218120196325517', '1268218114043019425', '1268220280166420572', '1268220287510384653', '1268220291788574814', '1268218121324462226', '1268218113137311877', '1268218101682405396', '1268218112319291462'];
  const bombs = ['1324782914847899648', '1268230328401788928', '1268229844676776099', '1268231995633307812', '1268231994840715355', '1268231996820160614'];
  const bombsWarn = ['1268231996459585650', '1268231992336449687'];
  const prof = ['1331682928979218462', '1331682931940528188', '1331682925401473095', '1331682920431226892', '1331682933265793096', '1331682936629497907', '1331682933655867472', '1331682934901444649', '1331682934259978445', '1331682935937564692', '1331682935627190283', '1331682937309102191'];
  const quests = ['1271168738002997279', '1269810703972171908', '1269810688352718918', '1268229834455253013', '1268229845398327417', '1268229846144647170', '1268229847075786853'];
  const classes = ['1269826644693221466', '1269826646886584413', '1269826649386385520', '1269826651878068374', '1269826654381805669', '1273252381018165308', '1295760021375815701'];

  const list = (ids) => ids.map((id) => `<@&${id}>`).join(' ');

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
      {
        color: COLOR.pings,
        description:
`**1. Pings de Experiência (XP)**
${list(xp)}

**2. Pings de Dungeon**
${list(dungeon)}

**3. Pings de Bombs**
${list(bombs)}
${list(bombsWarn)} — *avise antes de soltar!*`,
      },
      {
        color: COLOR.pings,
        description:
`**4. Pings de Profissões**
Peça para alguém coletar um recurso ou craftar um item para você.
${list(prof)}

**5. Pings de Quests e Raids**
Convide outros membros para participar com você.
${list(quests)}

**6. Pings de Classes e Eventos**
Encontre jogadores da mesma classe ou fique por dentro dos eventos.
${list(classes)}`,
      },
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
`Bem-vindo(a) ao canal de recrutamento! Aqui está o passo a passo para se juntar à nossa guilda:

**1️⃣ Sem requisitos obrigatórios**
> Nossa guilda é aberta para toda a comunidade, focada na língua portuguesa. Portugueses, angolanos e latinos em geral também são bem-vindos!

**2️⃣ Registre-se primeiro**
> Vincule sua conta no canal de registro. É de lá que sai o seu nick verificado — não precisa digitá-lo aqui.

**3️⃣ Envie sua candidatura**
> Use \`/apply submit\`. A candidatura aparece **neste canal** com uma votação aberta.
> O placar é público, mas **o voto é anônimo**: ninguém vê quem votou o quê.

**4️⃣ Aceite o convite**
> Aprovado? Um recrutador te chama no jogo. Aceite com \`/guild join WnBR\`.

**5️⃣ Escolha seus cargos**
> Passe em <id:customize> e marque seus interesses. Isso ajuda na sua integração.

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
    content: `|| <@&${MEMBER_ROLE}> ||`,
    embeds: [
      {
        title: '🛡️ Processo de Aplicação para Guerra',
        color: COLOR.war,
        description:
`Se você deseja se juntar ao nosso time de guerra, siga as diretrizes abaixo.

## 🎖️ Cargo de Guerreiro \`WAR\`
> Para fazer parte do exército geral:
> - Ter pelo menos uma classe **nível 105**.
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
    content: `|| <@&${MEMBER_ROLE}> ||`,
    embeds: [
      {
        title: '📜 Distribuição de Tomes',
        color: COLOR.tome,
        description:
`Regras e requisitos para receber o **Guild Tome**.

### Requisitos
> - Ter pelo menos uma classe de nível \`105\`.
> - Ter completado a quest \`Realm of Light I - The Worm Holes\`.
> - Ser membro da guilda há pelo menos \`1 semana\`.
>
> Todos são exigências do próprio jogo para usar Tomes de Guilda.

### Como a guilda consegue Tomes?
> **Buff de Território** — territórios conquistados em guerra (\`/guild attack\`) podem ter o buff *Tome Seeking*, que dá chance de encontrar Tomes exclusivos por hora.
> **Objetivos Semanais** — as missões semanais dão um baú de recompensas com Tome, além de Banner Points, esmeraldas e Guild XP.
> **Recompensa de Season** — territórios geram \`Season Rating\` por hora, e a temporada paga recompensas ao final.

### Como solicito meu Tome?
> Clique em **Entrar na fila** abaixo. O botão já te diz sua posição.
>
> **A fila é ordenada por pontos de contribuição**, não por ordem de chegada. Guerras, guild raids, objetivos semanais e Guild XP contam — quem mais ajuda a guilda recebe primeiro.
>
> Mesmo que seu Tome tenha atributos baixos, aguarde **30 dias** após receber um antes de pedir outro. Outros membros também precisam.

-# Para receber, vá em Bússola ➜ Bandeira ➜ Chave ➜ Maçã Dourada.`,
      },
    ],
    components: [
      row([
        { id: 'tome:join', label: 'Entrar na fila', emoji: '📜', style: ButtonStyle.Success },
        { id: 'tome:leave', label: 'Sair da fila', emoji: '🚪', style: ButtonStyle.Danger },
        { id: 'tome:queue', label: 'Ver fila', emoji: '📋' },
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
> **Solicitação:** peça a qualquer Estrategista ou superior da guilda.
>
> **Responsabilidade:** roubar é passível de banimento no Wynncraft. Ao retirar um item, você se compromete a devolvê-lo no prazo ou pagar o valor acordado.
>
> **Condição:** os itens devem voltar exatamente como saíram.
>
> **Transparência:** seu nome fica na lista de empréstimos até a devolução. O não cumprimento é registrado publicamente, independentemente do motivo.
>
> [**Wynncraft Rules**](https://forums.wynncraft.com/threads/game-forum-rules.111874/#post-3525357) — Seção 7 + Spoiler: *Information about loaning*

-# A staff registra cada empréstimo com \`/loan new\`. Lembretes automáticos são enviados perto do vencimento.`,
      },
      {
        title: '📄 Modelo de Acordo (fórum)',
        color: COLOR.loan,
        description:
`Copie e preencha ao abrir o tópico do empréstimo.

\`\`\`md
# Acordo de Empréstimo: Set Completo de XP Bônus

### Itens Incluídos
> Já protegidos com /itemlock e cedidos temporariamente:
> ...

### Data para Devolução
> Até <timestamp>.
> Devoluções antecipadas são livres. Para estender o prazo,
> um novo acordo deve ser formalizado.

### Valor Estimado
> Entre X e Y.

### Confirmação
> As prints do trade estão anexadas abaixo. Quem recebe o
> empréstimo deve confirmar a veracidade respondendo ao tópico.
\`\`\``,
      },
    ],
    components: [
      row([{ id: 'loan:mine', label: 'Meus empréstimos', emoji: '💰', style: ButtonStyle.Primary }]),
    ],
  };
}

// key = chave de canal em CHANNEL_KEYS; stateId = documento em watcherState.
export const PANELS = [
  { key: 'rules', stateId: 'rulesPanel', label: 'regras', build: rulesPayload },
  { key: 'pings', stateId: 'pingsPanel', label: 'pings', build: pingsPayload },
  { key: 'recruiters', stateId: 'recruitPanel', label: 'recrutamento', build: recruitPayload },
  { key: 'warApplication', stateId: 'warApplicationPanel', label: 'aplicação war', build: warApplicationPayload },
  { key: 'tome', stateId: 'tomePanel', label: 'tomes', build: tomePayload },
  { key: 'loans', stateId: 'loanPanel', label: 'empréstimos', build: loanPayload },
];

export async function ensureStaticPanels(client, guildDiscordId) {
  const cfg = await getConfig(guildDiscordId);
  for (const p of PANELS) {
    await ensurePanel(client, cfg.channels?.[p.key], p.stateId, p.build(), p.label);
  }
}

export const STATIC_PANEL_IDS = PANELS.map((p) => p.stateId);

export const PINGS_STATE_ID = 'pingsPanel';
