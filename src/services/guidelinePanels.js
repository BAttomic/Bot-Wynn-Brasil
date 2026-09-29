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
 * Os números saem dos parâmetros do bot, para a regra escrita não divergir da
 * aplicada. Os limiares das trilhas (guerras e pontos) ainda não são parâmetro:
 * vivem em TRILHAS, logo abaixo.
 */

const SILENT = { allowedMentions: { parse: [] } };
const fmt = (n) => Number(n).toLocaleString('pt-BR');

/** Limiares das trilhas War Team e Guild Staff. */
const TRILHAS = Object.freeze({ capitaoWar: 50, estrategistaWar: 100, capitaoStaff: 2500, estrategistaStaff: 5000 });

const ROLE = Object.freeze({
  community: '1262796663760752831',
  allies: '1554204990451753122',
  member: '1262796467488165908',
  warTeam: '1554163813387993208',
  staff: '1262574400587169863',
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
});

const c = (key) => `<#${CH[key]}>`;
const r = (key) => `<@&${ROLE[key]}>`;

function embed(title, color, description) {
  return { ...SILENT, embeds: [{ title, color, description }] };
}

function communityPayload() {
  return embed('📃 Diretrizes da Comunidade — Wynncraft Brasil', 0x5865f2,
`Valem para todo mundo no servidor: ${r('community')} e ${r('allies')}. A guilda, a War Team e a Staff seguem estas e acrescentam as suas.

### 📋 Registro
> Vincule sua conta do Wynncraft em ${c('registro')}: o bot confere na API oficial e te dá o cargo certo.
> Seu apelido vira **[TAG] Nick**, com a TAG da sua guilda, e se atualiza sozinho. Não troque à mão.
> Registre só contas que são suas.

### 🤝 Convivência
> Respeito acima de tudo: sem ofensa, preconceito, assédio ou provocação.
> Sem spam, flood, divulgação de outros servidores ou links suspeitos.
> Nada de conteúdo adulto, violento ou ilegal.
> Golpe e calote são proibidos, dentro e fora do jogo. As regras oficiais do Wynncraft também valem aqui.

### 💬 Canais
> ${c('conversas')} em português · ${c('englishGeneral')} em inglês · ${c('memes')} · ${c('exibicao')} para builds e drops · ${c('forum')} para dúvidas e guias.
> ${c('market')}: compra, venda e troca entre jogadores. A negociação é por sua conta — a staff não intermedeia.
> ${c('pings')}: reaja para escolher o que quer receber. Cada ping é só para o assunto dele.

### 🤝 Aliados
> Quem é de guilda aliada recebe ${r('allies')} e fala com a Wynn Brasil em ${c('gAllies')}.

### 🔨 Advertências e banimentos
> A moderação é feita pela staff, pelo bot, e tudo fica registrado. Advertência chega por DM.
> O banimento vale para a pessoa: todas as contas do jogo e todos os Discords dela.
> Quem é banido passa a ver só ${c('banimentos')}, onde um tópico privado com a staff reúne a evidência — e é ali que se contesta.

### 📣 Avisos
> ${c('anunciosComunidade')} — novidades do servidor · ${c('atualizacoesWynn')} — atualizações do Wynncraft.`);
}

/** @param {import('../config/guildConfig.js').GuildParams} p */
function guildPayload(p) {
  const w = p.pointsWeights;
  const xp = xpRate(w.contribPerMillion);
  const streak = Math.round(p.weeklyStreakBonusPerWeek * 100);
  return embed('📃 Diretrizes da Guilda — Wynn Brasil [WnBR]', 0x2ecc71,
`Valem para ${r('member')}, junto com as ${c('diretrizes')} da comunidade.

### 🎯 Entrada
> A candidatura é feita em ${c('recrutamento')} e votada pelos Chefes (Staff). Aprovado, você recebe o convite no jogo; ao entrar, o cargo e a TAG **[WnBR]** chegam sozinhos.

### ⭐ Contribuição
> Tudo o que você faz pela guilda vira ponto:
> 📈 **${fmt(xp.pts)}** a cada **${fmt(xp.xp)}** de Guild XP
> 🛡️ **${fmt(w.guildRaid)}** por guild raid
> ⚔️ **${fmt(w.war)}** por guerra, multiplicados pelo peso do território (até x${fmt(p.territoryMultiplierCap)})
> 📅 **${fmt(w.weekly)}** por objetivo semanal, **+${streak}%** por semana seguida
> Ranking e o botão **Meus pontos** em ${c('status')}. Os pontos ordenam a fila de Tomes, compram margem de inatividade e abrem a trilha da Staff.

### 📜 Tomes e ✨ Aspects
> Tomes: fila por pontos, **1 por objetivo semanal** cumprido. Precisa de **${p.rewardMinGuildDays} dias** de guilda e uma classe **nível ${p.tomeMinClassLevel}**.
> Aspects: **${String(p.aspectsPerGuildRaid).replace('.', ',')}** por guild raid, entregues pela staff a partir de **${p.rewardMinGuildDays} dias** de guilda. Tudo em ${c('tomesAspects')}.

### 💤 Inatividade
> Margem de **${p.inactivityDays} dias** offline, mais **1 dia** a cada **${fmt(p.inactivityForgivenessPerPoints)}** pontos (até **+${p.inactivityForgivenessMaxDays}**).
> Estourou a margem, chega uma DM: responda em **${p.inactivityCheckHours}h**. "Ainda quero jogar" te dá **${p.inactivityReturnDays} dias** para entrar no jogo.
> O kick só libera a vaga para quem está jogando: não é punição, e a volta é livre.

### 🎖️ Ranks e trilhas
> Capitão, Estrategista e Chefe representam o rank no jogo, em duas trilhas independentes: **War Team** (${c('warDiretrizes')}) e **Guild Staff** (${c('staffDiretrizes')}). No máximo um cargo por trilha.
> Quem tem rank e sai da guilda recebe **Ocioso**: mantém os cargos, perde o direito de voto, e o Ocioso sai sozinho na volta.

### 🎊 Dia a dia
> ${c('gConversas')} · ${c('eventos')} — competições e sorteios · ${c('emprestimos')} — empréstimos do baú, com acordo e prazo registrados pelo bot.

### 📣 Avisos
> ${c('anunciosWnbr')}.`);
}

function warPayload() {
  return embed('📃 Diretrizes da WnBR War Team', 0xe74c3c,
`Valem para ${r('warTeam')}, junto com as ${c('gDiretrizes')} da guilda.

### ⚔️ Como subir
> Contam só as guerras feitas **pela WnBR**:
> **${TRILHAS.capitaoWar} guerras** → ${r('warTeam')} e Capitão (War)
> **${TRILHAS.estrategistaWar} guerras** → Estrategista (War), no lugar do Capitão (War)
> **Chefe (War)** → a critério do Líder de Guerra. Inclui mover o QG no jogo.

### 🏆 MAIN WAR
> **DPS**, **HEALER**, **TANK** e **SOLO** são dados pelo Líder de Guerra, por confiança e avaliação da build. Quem tem MAIN WAR faz parte da War Team.
> Tenha uma classe dedicada à guerra, pronta a qualquer momento, com o mapa todo desbloqueado.

### 📡 Convocação
> Guerras são convocadas por ping manual. Território ganho e perdido aparece em ${c('warBot')}.

### 💬 Canais
> ${c('warConversas')} e 🔊 War para o time · ${c('warForum')} e ${c('mainWarConversas')} só para MAIN WAR · avisos em ${c('warAnuncios')}.

### 🔒 Sigilo
> Builds, estratégias e consumíveis do time são privados. Vazamento resulta em banimento.

### ⚖️ Limites
> A War Team não tem poder de kick, ban ou decisão sobre a guilda — isso é da Guild Staff.`);
}

/** @param {import('../config/guildConfig.js').GuildParams} p */
function staffPayload(p) {
  return embed('📃 Diretrizes da WnBR Guild Staff', 0xf1c40f,
`Valem para ${r('staff')}, junto com as ${c('gDiretrizes')} da guilda.

### 🎖️ Como subir
> **${fmt(TRILHAS.capitaoStaff)} pontos** → ${r('staff')} e Capitão (Staff)
> **${fmt(TRILHAS.estrategistaStaff)} pontos** → o bot avisa os Chefes (Staff); um Chefe abre a votação para Estrategista (Staff)
> **Chefe (Staff)** → um Chefe sugere e abre a votação; aprovada, o Owner confirma

### 🗳️ Votações
> Candidaturas e promoções são votadas pelos **Chefes (Staff)**. Prazo de **${p.voteWindowHours}h**; vale a maioria dos votos dados (abstenção não conta), e empate reprova. Ocioso não vota.

### 🔨 Moderação
> Ninguém usa kick ou ban do Discord: tudo passa pelo bot e fica registrado.
> **/warn** — Estrategista (Staff) ou acima. Registra e avisa por DM; não bane.
> **/ban** — só Chefe (Staff). Bane a pessoa inteira e abre um tópico privado em ${c('banimentos')} com o banido, quem baniu e os Chefes. Quem baniu coloca a evidência ou o relato.
> **Unban** e **promoção a Chefe** — só o Owner.

### 💬 Canais
> ${c('staffConversas')} e 🔊 Staff · ${c('staffForum')} para discussões longas · ${c('staffBot')} — auditoria e alertas · ${c('staffChiefs')} e 🔊 Meeting só para Chefes (Staff) · avisos em ${c('staffAnuncios')}.

### 🛡️ Hierarquia
> Fundador no topo, Wynn Brasil BOT logo abaixo. Qualquer mudança nisso gera alerta para o Owner.`);
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
