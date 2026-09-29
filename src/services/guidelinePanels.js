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
  community: '1262796663760752831',
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

const c = (key) => `<#${CH[key]}>`;
const r = (key) => `<@&${ROLE[key]}>`;

function embed(title, color, description) {
  return { ...SILENT, embeds: [{ title, color, description }] };
}

function communityPayload() {
  return embed('📃 Diretrizes da Comunidade — Wynncraft Brasil', 0x5865f2,
`Valem para todo mundo no servidor: ${r('community')} e ${r('allies')}. ${r('member')}, ${r('warTeam')} e ${r('staff')} seguem estas e acrescentam as suas.

### 📋 Registro
> Vincule sua conta do Wynncraft em ${c('registro')}: o bot confere na API oficial e te dá o cargo certo.
> Seu apelido vira **[TAG] Nick**, com a TAG da sua guilda, e se atualiza sozinho. Não troque à mão.
> Registre só contas que são suas.

### 🤝 Convivência
> Respeito acima de tudo: sem ofensa, preconceito, assédio ou provocação.
> Sem spam, flood, divulgação de outros servidores ou links suspeitos.
> Nada de conteúdo adulto, violento ou ilegal.
> Golpe e calote são proibidos, dentro e fora do jogo. As regras oficiais do Wynncraft também valem aqui.

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
> ${c('vozCallEterna')} e ${c('vozBatePapo')} — voz aberta`);
}

/** @param {import('../config/guildConfig.js').GuildParams} p */
function guildPayload(p) {
  const w = p.pointsWeights;
  const xp = xpRate(w.contribPerMillion);
  const streak = Math.round(p.weeklyStreakBonusPerWeek * 100);
  return embed('📃 Diretrizes da Guilda — Wynn Brasil [WnBR]', 0x2ecc71,
`Valem para ${r('member')}, junto com as ${c('diretrizes')} da comunidade.

### ⭐ Contribuição
> Tudo o que você faz pela guilda vira ponto:
> 📈 **${fmt(xp.pts)}** a cada **${fmt(xp.xp)}** de Guild XP
> 🛡️ **${fmt(w.guildRaid)}** por guild raid
> ⚔️ **${fmt(w.war)}** por guerra, multiplicados pelo peso do território (até x${fmt(p.territoryMultiplierCap)})
> 📅 **${fmt(w.weekly)}** por objetivo semanal, **+${streak}%** por semana seguida
> Os pontos ordenam a fila de Tomes, compram margem de inatividade e abrem a trilha da ${r('staff')}.

### 📜 Tomes e ✨ Aspects
> Tomes: fila por pontos, **1 por objetivo semanal** cumprido. Precisa de **${p.rewardMinGuildDays} dias** de guilda e uma classe **nível ${p.tomeMinClassLevel}**.
> Aspects: **${String(p.aspectsPerGuildRaid).replace('.', ',')}** por guild raid, entregues pela ${r('staff')} a partir de **${p.rewardMinGuildDays} dias** de guilda.

### 💤 Inatividade
> Margem de **${p.inactivityDays} dias** offline, mais **1 dia** a cada **${fmt(p.inactivityForgivenessPerPoints)}** pontos (até **+${p.inactivityForgivenessMaxDays}**).
> Estourou a margem, chega uma DM: responda em **${p.inactivityCheckHours}h**. "Ainda quero jogar" te dá **${p.inactivityReturnDays} dias** para entrar no jogo.
> O kick só libera a vaga para quem está jogando: não é punição, e a volta é livre.

### 🎖️ Trilhas
> Capitão, Estrategista e Chefe representam o rank no jogo, em duas trilhas independentes. No máximo um cargo por trilha.
> ⚔️ **${TRILHAS.capitaoWar} guerras** feitas pela WnBR → ${r('warTeam')} e ${r('capitaoWar')}. Os próximos passos ficam em ${c('warDiretrizes')}.
> 🛡️ **${fmt(TRILHAS.capitaoStaff)} pontos** → ${r('staff')} e ${r('capitaoStaff')}. Os próximos passos ficam em ${c('staffDiretrizes')}.
> Quem tem rank e sai da guilda recebe ${r('ocioso')}: mantém os cargos, perde o direito de voto, e o cargo sai sozinho na volta.

### 📌 Canais
> ${c('anunciosWnbr')} — avisos da guilda
> ${c('gConversas')} — papo da guilda
> ${c('status')} — status ao vivo, ranking, **Meus pontos**, uniforme e modpack
> ${c('tomesAspects')} — fila de Tomes e aspects a receber
> ${c('eventos')} — competições e sorteios
> ${c('emprestimos')} — empréstimos do baú, com acordo e prazo registrados pelo bot`);
}

function warPayload() {
  return embed('📃 Diretrizes da WnBR War Team', 0xe74c3c,
`Valem para ${r('warTeam')}, junto com as ${c('gDiretrizes')} da guilda.

### 🎖️ Próximas promoções
> **${TRILHAS.estrategistaWar} guerras** pela WnBR → ${r('estrategistaWar')}, no lugar do ${r('capitaoWar')}
> ${r('chefeWar')} → a critério do Líder de Guerra. Inclui mover o QG no jogo.

### 🏆 MAIN WAR
> ${r('mainDps')}, ${r('mainHealer')}, ${r('mainTank')} e ${r('mainSolo')} são dados pelo Líder de Guerra, por confiança e avaliação da build. Quem tem qualquer um deles faz parte da ${r('warTeam')}.
> Tenha uma classe dedicada à guerra, pronta a qualquer momento, com o mapa todo desbloqueado.

### 📡 Convocação
> Guerras são convocadas por ping manual.

### 🔒 Sigilo
> Builds, estratégias e consumíveis do time são privados. Vazamento resulta em banimento.

### ⚖️ Limites
> A ${r('warTeam')} não tem poder de kick, ban ou decisão sobre a guilda — isso é da ${r('staff')}.

### 📌 Canais
> ${c('warAnuncios')} — avisos do time
> ${c('warConversas')} — papo do time
> ${c('vozWar')} — call das guerras
> ${c('warBot')} — território ganho e perdido, ao vivo
> ${c('warForum')} — só MAIN WAR: builds e estratégias
> ${c('mainWarConversas')} — só MAIN WAR`);
}

/** @param {import('../config/guildConfig.js').GuildParams} p */
function staffPayload(p) {
  return embed('📃 Diretrizes da WnBR Guild Staff', 0xf1c40f,
`Valem para ${r('staff')}, junto com as ${c('gDiretrizes')} da guilda.

### 🎖️ Próximas promoções
> **${fmt(TRILHAS.estrategistaStaff)} pontos** → o bot avisa os ${r('chefeStaff')}; um deles abre a votação para ${r('estrategistaStaff')}
> ${r('chefeStaff')} → um Chefe sugere e abre a votação; aprovada, o ${r('fundador')} confirma

### 🗳️ Votações
> Candidaturas e promoções são votadas pelos ${r('chefeStaff')}. Prazo de **${p.voteWindowHours}h**; vale a maioria dos votos dados (abstenção não conta), e empate reprova. ${r('ocioso')} não vota.

### 🔨 Moderação
> Ninguém usa kick ou ban do Discord: tudo passa pelo bot e fica registrado.
> **/warn** — ${r('estrategistaStaff')} ou acima. Registra e avisa por DM; não bane.
> **/ban** — só ${r('chefeStaff')}. Bane a pessoa inteira e abre um tópico privado em ${c('banimentos')} com o banido, quem baniu e os Chefes. Quem baniu coloca a evidência ou o relato.
> **Unban** e **promoção a Chefe** — só o ${r('fundador')}.

### 🛡️ Hierarquia
> ${r('fundador')} no topo, ${r('bot')} logo abaixo. Qualquer mudança nisso gera alerta para o Fundador.

### 📌 Canais
> ${c('staffAnuncios')} — avisos da staff
> ${c('staffConversas')} — papo da staff
> ${c('vozStaff')} — call da staff
> ${c('staffForum')} — discussões longas e casos
> ${c('staffBot')} — auditoria, alertas de recrutamento e de hierarquia, relatório de verificação
> ${c('staffChiefs')} — só ${r('chefeStaff')}
> ${c('vozMeeting')} — só ${r('chefeStaff')}`);
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
