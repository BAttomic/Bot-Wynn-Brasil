import { getConfig } from '../config/guildConfig.js';
import { ensurePanel } from './panels.js';
import { xpRate } from './points.js';
import { logoAttachment, brandWithLogo } from '../util/assets.js';

/**
 * Diretrizes, uma por categoria do servidor, em HERANÇA:
 *
 *   Comunidade ──► Guilda ──┬──► War Team
 *                           └──► Guild Staff
 *
 * Cada nível vale junto com os de cima e só escreve o que é DELE — a guilda não
 * repete a convivência da comunidade, a Staff não repete os pontos da guilda.
 * War Team e Guild Staff são ramos paralelos: um não herda do outro.
 *
 * Todo painel tem duas partes, como o painel de regras que a staff escreveu:
 * **Regras** (o que é proibido ou exigido) e **Avisos** (como as coisas
 * funcionam — nada ali é proibição).
 *
 * Como ENTRAR num nível fica no painel de ANTES dele: quem quer entrar na guilda
 * ainda não vê as diretrizes da guilda, e quem quer entrar na War Team não vê as
 * da War Team. Cada painel diz como chegar ao próximo passo, nunca ao atual.
 *
 * Os números saem dos parâmetros do bot, para a regra escrita não divergir da
 * aplicada. Os limiares das trilhas (guerras e pontos) ainda não são parâmetro:
 * vivem em TRILHAS, logo abaixo.
 */

const SILENT = { allowedMentions: { parse: [] } };
const fmt = (n) => Number(n).toLocaleString('pt-BR');

/** Limiares das trilhas War Team e Guild Staff. */
const TRILHAS = Object.freeze({ capitaoWar: 50, estrategistaWar: 100, capitaoStaff: 2500, estrategistaStaff: 5000 });

const ROLE = Object.freeze({
  allies: '1554204990451753122',
  member: '1262796467488165908',
  warTeam: '1554163813387993208',
  staff: '1262574400587169863',
  capitaoWar: '1554261272755699722',
  estrategistaWar: '1554224233767239750',
  chefeWar: '1268208318439096461',
  capitaoStaff: '1268208319865159773',
  estrategistaStaff: '1268208318946742312',
  chefeStaff: '1554224233721372692',
  mainDps: '1333249418945892422',
  mainHealer: '1333249422137495664',
  mainTank: '1333249407193448548',
  mainSolo: '1332557073656975370',
  ocioso: '1531488822708273152',
  banido: '1340443882101538816',
  fundador: '1268208310423781426',
  bot: '1554204860138917918',
});

const CH = Object.freeze({
  diretrizes: '1261404630194196620',
  registro: '1524879591812890695',
  banimentos: '1524880355788853488',
  anunciosComunidade: '1262808584706850868',
  anunciosWnbr: '1265848355452616828',
  atualizacoesWynn: '1304566430343102494',
  forum: '1261849198979055637',
  conversas: '1212766244869115916',
  englishGeneral: '1554176636511981709',
  memes: '1261851228925722686',
  market: '1262153374481252405',
  exibicao: '1531758807485779978',
  pings: '1524986783694065736',
  emprestimos: '1274938119137001545',
  gDiretrizes: '1554172918970458123',
  gConversas: '1263667335152013354',
  gAllies: '1554176772688322570',
  recrutamento: '1309848293278486578',
  status: '1524920847637155861',
  tomesAspects: '1263562192389673154',
  eventos: '1532443328514097202',
  warDiretrizes: '1554170478179131403',
  warAnuncios: '1554170883432517675',
  warForum: '1333104457692610560',
  mainWarConversas: '1332556988176924702',
  warConversas: '1554170751651676281',
  warBot: '1339335589056610374',
  staffDiretrizes: '1554170206849597573',
  staffAnuncios: '1554169631231451276',
  staffForum: '1554168969525600377',
  staffChiefs: '1332548770940063776',
  staffConversas: '1267311891072417886',
  staffBot: '1524911725424414861',
  vozCallEterna: '1262155312769794068',
  vozBatePapo: '1267240558405877902',
  vozWar: '1554171100823552010',
  vozStaff: '1327509080105025556',
  vozMeeting: '1554171016329302176',
});

/** Líder de Guerra: NinjaBR_. Trocou de líder, troca aqui. */
const LIDER_DE_GUERRA = '457030050383003650';

const c = (key) => `<#${CH[key]}>`;
const r = (key) => `<@&${ROLE[key]}>`;

const COR = Object.freeze({ comunidade: 0x5865f2, guilda: 0x2ecc71, war: 0xe74c3c, staff: 0xf1c40f });

/** Um painel = uma mensagem com dois embeds: Regras em cima, Avisos embaixo. */
function painel(cor, regras, avisos) {
  return {
    ...SILENT,
    embeds: [
      { color: cor, ...regras },
      { color: cor, ...avisos },
    ],
  };
}

// ────────────────────────────────────────────────────────────── Comunidade

function communityPayload() {
  return painel(
    COR.comunidade,
    {
      title: '📜 Regras da Comunidade Wynn Brasil',
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
> - Golpe e calote são proibidos, dentro e fora do jogo.
> - Registre no bot só contas que são suas.
> - Seja um bom representante da comunidade dentro e fora do jogo.

## 6. Colaboração e Diversão
> - Participe de forma colaborativa e ajude a manter um ambiente positivo.
> - Lembre-se: estamos aqui para nos divertir e crescer juntos!

### Observações Importantes
- Caso presencie comportamento inadequado, denuncie à ${r('staff')}.
- Violações podem resultar em advertências ou banimentos, dependendo da gravidade.`,
    },
    {
      title: '📢 Avisos da Comunidade Wynn Brasil',
      description:
`Como o servidor funciona. Nada aqui é proibição — as regras estão acima.

### 📋 Registro
> Vincule sua conta do Wynncraft em ${c('registro')}: o bot confere na API oficial e te dá o cargo certo.
> Seu apelido vira **[TAG] Nick**, com a TAG da sua guilda, e se atualiza sozinho. Não troque à mão.

### 🏰 Entrar na Wynn Brasil
> Candidate-se em ${c('recrutamento')}. A candidatura é votada pelos ${r('chefeStaff')}; aprovado, você recebe o convite no jogo, e ao entrar o ${r('member')} e a TAG **[WnBR]** chegam sozinhos.

### 🔨 Advertências e banimentos
> A moderação é feita pela ${r('staff')}, pelo bot, e tudo fica registrado. Advertência chega por DM.
> O banimento vale para a pessoa: todas as contas do jogo e todos os Discords dela.
> Quem recebe ${r('banido')} passa a ver só ${c('banimentos')}, onde um tópico privado com a staff reúne a evidência — e é ali que se contesta.

### 📌 Canais
> ${c('anunciosComunidade')} — novidades do servidor
> ${c('atualizacoesWynn')} — atualizações do Wynncraft
> ${c('conversas')} — papo em português
> ${c('englishGeneral')} — chat in English
> ${c('forum')} — dúvidas, guias e builds
> ${c('market')} — compra, venda e troca; a negociação é por sua conta, a ${r('staff')} não intermedeia
> ${c('exibicao')} — mostre suas builds e drops
> ${c('memes')} — memes
> ${c('pings')} — reaja para escolher seus pings; cada ping é só para o assunto dele
> ${c('gAllies')} — aliados (${r('allies')}) e a guilda conversam aqui
> ${c('vozCallEterna')} e ${c('vozBatePapo')} — voz aberta

-# Divirta-se e boas aventuras em Wynncraft!`,
    },
  );
}

// ────────────────────────────────────────────────────────────── Guilda

/** @param {import('../config/guildConfig.js').GuildParams} p */
function guildPayload(p) {
  const w = p.pointsWeights;
  const xp = xpRate(w.contribPerMillion);
  const streak = Math.round(p.weeklyStreakBonusPerWeek * 100);
  const base = p.inactivityDays;
  const per = p.inactivityForgivenessPerPoints;
  const maxDias = p.inactivityForgivenessMaxDays;
  // Exemplo de 10 dias de perdão, escrito a partir do divisor real.
  const exemploDias = Math.min(maxDias, 10);

  return painel(
    COR.guilda,
    {
      title: '📜 Regras da Guilda Wynn Brasil',
      description:
`Valem para ${r('member')}, junto com as ${c('diretrizes')} da comunidade.

## 1. Guild Bank
> - O Guild Bank é público e aberto para todos. Pegue o que precisar.
> - **Scrolls** e **Ferramentas** devem ser devolvidos após o uso. Pegou? Devolva!

## 2. Empréstimos
> - O que sai emprestado em ${c('emprestimos')} volta no prazo combinado e exatamente como saiu.
> - O não cumprimento fica registrado, independentemente do motivo.`,
    },
    {
      title: '🛡️ Avisos da Guilda Wynn Brasil',
      description:
`Como a guilda funciona por dentro: o que rende ponto, o que o ponto compra, e o que libera vaga. Nada aqui é proibição.

## 1. Pontos de Contribuição
Tudo que você faz pela guilda vira ponto, e ponto vira três coisas: **prioridade na fila de Tomes**, **margem de inatividade** e o caminho para a ${r('staff')}. A contagem é automática — ninguém precisa avisar nada.

> **Objetivo Semanal** — \`${fmt(w.weekly)} pontos\`, +${streak}% por semana seguida (até o dobro). É o que mais rende por tempo gasto.
> **Guild Raid** — \`${fmt(w.guildRaid)} pontos\` para **cada** membro nosso no grupo. Ainda rende aspects (abaixo).
> **Guerra** — \`${fmt(w.war)} pontos\` por guerra do **seu** contador, multiplicados pelo **peso do território** que a guilda tomou: fronteiras e QG do defensor, vezes a **dificuldade** que o jogo dá àquela torre (teto de x${fmt(p.territoryMultiplierCap)}).
> **Guild XP** (\`/guild xp 100\`) — \`${fmt(xp.pts)} ponto\` a cada \`${fmt(xp.xp)}\`. Sobe o nível da guilda, o que libera mais slots de membro e de baú.
> **Farm em grupo** — não pontua, mas rende amizade, dicas e progresso mais rápido.

Em ${c('status')}, o botão **Meus pontos** mostra os seus, sua posição em cada categoria e quantos dias de tolerância eles te dão.

## 2. Tomes e Aspects
São as duas recompensas que a guilda distribui, e as duas saem por fila automática em ${c('tomesAspects')}. Não precisa pedir nem cobrar.

> **Tomes** — a fila é por **pontos**: quem mais contribuiu recebe primeiro, **1 Tome por objetivo semanal** cumprido. Requisitos do próprio jogo: alguma classe no nível **${p.tomeMinClassLevel}** e **${p.rewardMinGuildDays} dias** de guilda.
> **Aspects** — saem das **guild raids**: cada raid rende \`${fmt(p.aspectsPerGuildRaid)}\` aspect a **cada** membro nosso que participou, inclusive quem fechou **sozinho**. Também exige **${p.rewardMinGuildDays} dias** de guilda. Aspect é item inteiro: meio aspect fica no seu saldo e vira unidade na próxima raid.

## 3. Inatividade e Expulsão
> Membros que ficarem **${base} dias offline** podem ser removidos.
> **Quem contribui ganha margem:** a cada **${fmt(per)} pontos**, **+1 dia** de perdão, até **+${maxDias} dias**. Exemplo: ${fmt(per * 10)} pontos = ${base} + ${exemploDias} = **${base + exemploDias} dias** de tolerância.

**Ninguém é expulso sem ser perguntado.** Ao atingir o seu limite, o bot te chama **no privado**: *ainda quero jogar* ou *perdi o interesse*. Sem resposta em ${p.inactivityCheckHours}h, o nome vai para a lista da staff. Quem quer ficar ganha **${p.inactivityReturnDays} dias para entrar no jogo** — um login zera o contador.

**Isso não é punição.** Um slot parado é um slot que um membro ativo não pode ocupar. E expulsão por inatividade **não é banimento**: dá para voltar quando quiser, pelo ${c('recrutamento')}.

## 4. Trilhas: War Team e Guild Staff
> Capitão, Estrategista e Chefe representam o rank no jogo, em duas trilhas independentes. No máximo um cargo por trilha.
> ⚔️ **${TRILHAS.capitaoWar} guerras** feitas pela WnBR → ${r('warTeam')} e ${r('capitaoWar')}. Os próximos passos ficam em ${c('warDiretrizes')}.
> 🛡️ **${fmt(TRILHAS.capitaoStaff)} pontos** → ${r('staff')} e ${r('capitaoStaff')}. Os próximos passos ficam em ${c('staffDiretrizes')}.
> Quem tem rank e sai da guilda recebe ${r('ocioso')}: mantém os cargos, perde o direito de voto, e o cargo sai sozinho na volta.

## 5. Canais
> ${c('anunciosWnbr')} — avisos da guilda
> ${c('gConversas')} — papo da guilda
> ${c('eventos')} — competições e sorteios

**Dúvidas ou sugestões?** Procure um membro da ${r('staff')}. Estamos aqui para ajudar!`,
    },
  );
}

// ────────────────────────────────────────────────────────────── War Team

function warPayload() {
  return painel(
    COR.war,
    {
      title: '📜 Regras da WnBR War Team',
      description:
`Valem para ${r('warTeam')}, junto com as ${c('gDiretrizes')} da guilda.

## 1. Sigilo
> - O que é da guerra fica no time: builds, estratégias, auraspots e consumíveis não saem dele.
> - Vazamento resulta em banimento.

## 2. Limites
> - A ${r('warTeam')} não tem poder de kick, ban ou decisão sobre a guilda — isso é da ${r('staff')}.`,
    },
    {
      title: '⚔️ Avisos da WnBR War Team',
      description:
`### ⚔️ O papel da War Team
> A War Team é quem defende e conquista o território da Wynn Brasil. O coração do time é **estar nas guerras**, e cada um soma do jeito que pode:
> 🧪 **Recursos** — consumíveis, ingredientes e materiais deixam o time sempre pronto. Toda ajuda conta.
> 🧠 **Conhecimento** — evoluir as builds, descobrir auraspots e propor estratégias é o que faz o time crescer.

### 🎖️ Próximas promoções
> **${TRILHAS.estrategistaWar} guerras** pela WnBR → ${r('estrategistaWar')}, no lugar do ${r('capitaoWar')}
> ${r('chefeWar')} → a critério do Líder de Guerra, <@${LIDER_DE_GUERRA}>. Inclui mover o QG no jogo.

### 🏆 MAIN WAR
> ${r('mainDps')}, ${r('mainHealer')}, ${r('mainTank')} e ${r('mainSolo')} são dados pelo Líder de Guerra, por confiança e avaliação da build. Quem tem qualquer um deles faz parte da ${r('warTeam')}.
> Espera-se de um MAIN WAR uma classe dedicada à guerra, pronta a qualquer momento, com o mapa todo desbloqueado.

### 📡 Convocação
> Guerras são convocadas por ping manual.

### 📌 Canais
> ${c('warAnuncios')} — avisos do time
> ${c('warConversas')} — papo do time
> ${c('vozWar')} — call das guerras
> ${c('warBot')} — território ganho e perdido, ao vivo
> ${c('warForum')} — só MAIN WAR: builds e estratégias
> ${c('mainWarConversas')} — só MAIN WAR`,
    },
  );
}

// ────────────────────────────────────────────────────────────── Guild Staff

/** @param {import('../config/guildConfig.js').GuildParams} p */
function staffPayload(p) {
  return painel(
    COR.staff,
    {
      title: '📜 Regras da WnBR Guild Staff',
      description:
`Valem para ${r('staff')}, junto com as ${c('gDiretrizes')} da guilda.

## 1. Moderação pelo bot
> - Ninguém usa kick ou ban do Discord: tudo passa pelo bot e fica registrado.
> - **/warn** — ${r('estrategistaStaff')} ou acima. Registra e avisa por DM; não bane.
> - **/ban** — só ${r('chefeStaff')}. Bane a pessoa inteira: todas as contas e todos os Discords.
> - **Unban** e **promoção a Chefe** — só o ${r('fundador')}.

## 2. Evidência
> - Todo ban abre um tópico privado em ${c('banimentos')} com o banido, quem baniu e os Chefes.
> - Quem baniu coloca ali a evidência ou o relato. O banido contesta no mesmo tópico.`,
    },
    {
      title: '🤝 Avisos da WnBR Guild Staff',
      description:
`### 🤝 O papel da Staff
> A Staff é quem mantém a guilda de pé no dia a dia. Contamos com você em três frentes — **moderação**, **recrutamento** e **contribuição** — e em especial com:
> 🛡️ **Guild Raids** — movem a guilda e rendem aspects para todos. A Staff puxa o ritmo.
> 🌱 **Novatos** — quem chega precisa de um norte: informação, e quando der, ajuda direta, como os sets de XP do Guild Bank emprestados em ${c('emprestimos')} e os XP grinds em grupo.
> 📚 **Confiança** — a palavra da Staff é referência. Na dúvida, confira antes de responder.

### 🎖️ Próximas promoções
> **${fmt(TRILHAS.estrategistaStaff)} pontos** → o bot abre sozinho a votação dos ${r('chefeStaff')} para ${r('estrategistaStaff')}
> ${r('chefeStaff')} → um Chefe sugere e abre a votação; aprovada, o ${r('fundador')} confirma

### 🗳️ Votações
> Candidaturas e promoções são votadas pelos ${r('chefeStaff')}. Prazo de **${p.voteWindowHours}h**; vale a maioria dos votos dados (abstenção não conta), e empate reprova.

### 🛡️ Hierarquia
> ${r('fundador')} no topo, ${r('bot')} logo abaixo. Qualquer mudança nisso gera alerta para o Fundador.

### 📌 Canais
> ${c('staffAnuncios')} — avisos da staff
> ${c('staffConversas')} — papo da staff
> ${c('vozStaff')} — call da staff
> ${c('staffForum')} — discussões longas e casos
> ${c('staffBot')} — auditoria, alertas de recrutamento e de hierarquia, relatório de verificação
> ${c('staffChiefs')} — só ${r('chefeStaff')}
> ${c('vozMeeting')} — só ${r('chefeStaff')}`,
    },
  );
}

/**
 * Canal fixo, estado do painel e montagem, na ordem de publicação. A comunidade
 * usa o `rulesPanel`, o estado do painel de regras que existia antes, para
 * editar a mesma mensagem em vez de postar outra.
 */
const PANELS = Object.freeze([
  { channelId: CH.diretrizes, stateId: 'rulesPanel', label: 'diretrizes da comunidade', build: communityPayload },
  { channelId: CH.gDiretrizes, stateId: 'guildRulesPanel', label: 'diretrizes da guilda', build: guildPayload },
  { channelId: CH.warDiretrizes, stateId: 'warRulesPanel', label: 'diretrizes do war team', build: warPayload },
  { channelId: CH.staffDiretrizes, stateId: 'staffRulesPanel', label: 'diretrizes da staff', build: staffPayload },
]);

/** Só para teste: monta os quatro sem Discord. */
export const GUIDELINE_PANELS = PANELS;

export async function ensureGuidelinePanels(client, guildDiscordId) {
  const { params } = await getConfig(guildDiscordId);
  for (const p of PANELS) {
    await ensurePanel(client, p.channelId, p.stateId, brandWithLogo(p.build(params)), p.label, [logoAttachment()]);
  }
}
