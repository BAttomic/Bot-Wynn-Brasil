import { getConfig } from '../config/guildConfig.js';
import { ensurePanel } from './panels.js';
import { xpRate } from './points.js';
import { logoAttachment, brandWithLogo } from '../util/assets.js';

/**
 * Diretrizes de cada categoria: guilda, War Team e Staff. As da comunidade são o
 * painel de regras de sempre (staticPanels.js, canal 📃・diretrizes).
 *
 * RASCUNHO. O texto final vem da staff; até lá, isto descreve as regras
 * combinadas na reestruturação do Discord, com os números saindo dos parâmetros
 * do bot — assim a regra escrita não diverge da aplicada.
 */

const SILENT = { allowedMentions: { parse: [] } };
const RASCUNHO = '-# 📝 Rascunho — o texto final ainda será escrito pela staff.';
const fmt = (n) => Number(n).toLocaleString('pt-BR');

/** @param {import('../config/guildConfig.js').GuildParams} p */
function guildPayload(p) {
  const w = p.pointsWeights;
  const xp = xpRate(w.contribPerMillion);
  const streak = Math.round(p.weeklyStreakBonusPerWeek * 100);
  return {
    ...SILENT,
    embeds: [
      {
        title: '📃 Diretrizes da Guilda — Wynn Brasil [WnBR]',
        color: 0x2ecc71,
        description:
`### 🏰 Quem é da guilda
> Quem está na **Wynn Brasil** no jogo e registrou a conta recebe <@&1262796467488165908>. O apelido vira **[WnBR] Nick** sozinho.

### ⭐ Pontos de contribuição
> 📈 **${fmt(xp.pts)}** ponto a cada **${fmt(xp.xp)}** de Guild XP
> 🛡️ **${fmt(w.guildRaid)}** pontos por guild raid
> ⚔️ **${fmt(w.war)}** pontos por guerra, multiplicados pelo peso do território
> 📅 **${fmt(w.weekly)}** pontos por objetivo semanal, **+${streak}%** por semana seguida
> Os pontos definem a fila de Tomes, a margem de inatividade e as promoções.

### 🎖️ Promoções
> **Staff:** ${fmt(2500)} pontos → Capitão (Staff). ${fmt(5000)} pontos → Estrategista (Staff), com votação dos Chefes.
> **War Team:** 50 guerras pela WnBR → Capitão (War). 100 guerras → Estrategista (War).
> Detalhes em cada canal de diretrizes.

### 💤 Inatividade
> Até **${p.inactivityDays} dias** offline, mais **1 dia** a cada **${fmt(p.inactivityForgivenessPerPoints)}** pontos (máx. **+${p.inactivityForgivenessMaxDays}**). Antes de qualquer kick você recebe uma DM perguntando se ainda quer jogar.

### 📜 Tomes e ✨ Aspects
> Fila de Tomes por pontos: **1 Tome por objetivo semanal** cumprido, a partir de **${p.rewardMinGuildDays} dias** de guilda. Aspects: **${String(p.aspectsPerGuildRaid).replace('.', ',')}** por guild raid.

${RASCUNHO}`,
      },
    ],
  };
}

function warPayload() {
  return {
    ...SILENT,
    embeds: [
      {
        title: '📃 Diretrizes do War Team — Wynn Brasil',
        color: 0xe74c3c,
        description:
`### ⚔️ WnBR War Team
> Guerras feitas **pela WnBR** abrem o caminho:
> **50 guerras** → <@&1554163813387993208> e Capitão (War)
> **100 guerras** → Estrategista (War), no lugar do Capitão (War)
> Um cargo de War por vez, sempre o mais alto.

### 🏆 MAIN WAR
> **DPS**, **HEALER**, **TANK** e **SOLO** são dados pela liderança de guerra, por confiança. Quem tem MAIN WAR faz parte da War Team.
> 👥・war-forum e 💬・main-war-conversas são só dos MAIN WAR.

### 👑 Chefe (War)
> A critério do Líder de Guerra. Inclui a permissão de mover o QG no jogo.

### 🔒 Sigilo
> Builds, estratégias e consumíveis são informação privada. Vazamento resulta em **banimento permanente** da guilda e da comunidade.

### ⚖️ Limites
> A War Team não tem poder de kick/ban nem de decisão sobre a guilda.
> Convocações de guerra são feitas por ping manual.

${RASCUNHO}`,
      },
    ],
  };
}

/** @param {import('../config/guildConfig.js').GuildParams} p */
function staffPayload(p) {
  return {
    ...SILENT,
    embeds: [
      {
        title: '📃 Diretrizes da Staff — Wynn Brasil',
        color: 0x5865f2,
        description:
`### 🎖️ Promoção na Staff
> **${fmt(2500)} pontos** → Capitão (Staff) e <@&1262574400587169863>
> **${fmt(5000)} pontos** → o bot avisa os Chefes (Staff); um Chefe abre a votação, e a maioria aprova o Estrategista (Staff).
> **Chefe (Staff)** → um Chefe sugere e abre a votação; aprovada, o Owner confirma.
> Um cargo por trilha, sempre o mais alto. As trilhas Staff e War são independentes.

### 🗳️ Votações
> Votam os **Chefes (Staff)**. Prazo de **${p.voteWindowHours}h**; vale a maioria dos votos dados (abstenção não conta), e empate reprova.
> **Ocioso** — quem tem cargo de Função e está fora da guilda — não vota em nada.

### 🔨 Moderação
> Ninguém usa kick/ban do Discord: a moderação é pelo bot.
> **/warn** — Estrategista (Staff) para cima, vale para a guilda e para a comunidade.
> **/ban** — só Chefe (Staff). Todo ban abre um tópico privado em 🚫・banimentos com o banido, quem baniu e os Chefes (Staff). Quem baniu coloca a evidência ou o relato; o banido pode contestar ali.
> **Unban** e **promoção a Chefe** — só o Owner.

### 🏛️ Canais
> 💬・staff-chiefs e 🔊・Meeting são só dos Chefes (Staff).

### 🛡️ Hierarquia
> Fundador no topo, Wynn Brasil BOT logo abaixo. Qualquer alteração nisso gera alerta para o Owner.

${RASCUNHO}`,
      },
    ],
  };
}

/** Canal fixo, estado do painel e montagem, na ordem de publicação. */
const PANELS = Object.freeze([
  { channelId: '1554172918970458123', stateId: 'guildRulesPanel', label: 'diretrizes da guilda', build: guildPayload },
  { channelId: '1554170478179131403', stateId: 'warRulesPanel', label: 'diretrizes do war team', build: warPayload },
  { channelId: '1554170206849597573', stateId: 'staffRulesPanel', label: 'diretrizes da staff', build: staffPayload },
]);

export async function ensureGuidelinePanels(client, guildDiscordId) {
  const { params } = await getConfig(guildDiscordId);
  for (const p of PANELS) {
    await ensurePanel(client, p.channelId, p.stateId, brandWithLogo(p.build(params)), p.label, [logoAttachment()]);
  }
}
