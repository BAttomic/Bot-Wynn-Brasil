# Design — Bot de Guilda WynnCraft (Discord)

> Documento vivo de planejamento. Nada aqui é código final; serve para alinhar
> arquitetura e regras antes da implementação.

## 1. Objetivo

Bot de Discord para gerir uma guilda do WynnCraft, cobrindo: vínculo de conta,
acesso à comunidade, candidatura + votação para entrar na guilda, sincronização
de cargos, rastreio de progresso (incluindo guerras lutadas **pela guilda**),
pings de guerra, fila de Tomes por contribuição e um livro-razão de empréstimos.

## 2. Stack

- **Runtime:** Node.js (LTS)
- **Discord:** `discord.js` v14 (slash commands, botões, embeds)
- **Banco:** MongoDB via `mongoose`
- **Agendamento:** `node-cron` (jobs de votação, snapshots, lembretes, sync de cargos)
- **API WynnCraft v3:** cliente HTTP próprio com cache (respeita `Cache-Control`),
  rate-limit e **API key** registrada (aumenta o limite de req/min — necessário
  para o polling).
  - Base: `https://api.wynncraft.com/v3`
  - Player: `/player/{nick}?fullResult`
  - Guild: `/guild/prefix/{TAG}` ou `/guild/name/{nome}`

## 3. Decisões travadas

| Tema | Decisão |
|---|---|
| Verificação de conta | **Só nick + confiança na guilda** (sem OAuth). Mitigações: UUID único, cross-check no ingresso, `/unlink` de staff. |
| Stack | **Node.js + discord.js** |
| Ping de guerra | **Trigger manual** por quem tem cargo WAR / MAIN WAR |
| Guerras lutadas | **Rastreio diário** do delta de `globalData.wars` enquanto o UUID está na guilda |
| Empréstimos | **Ledger de confiança + lembretes** (transferência real é in-game) |
| Config de canais | Chaves configuráveis (ex.: chat de registro) via comando de admin |

## 4. Módulo de Configuração (canais, cargos e parâmetros)

Toda referência a canal/cargo/parâmetro é configurável — nada hardcoded. Guardado
na coleção `config` (um documento por guilda do Discord / `guildDiscordId`).

### Chaves de canais
| Chave | Uso |
|---|---|
| `registration` | Chat de registro — onde se usa `/link` |
| `applications` | Canal da liderança onde aparecem as candidaturas + botões de voto |
| `recruiters` | Onde cai o ping de recrutamento com o atalho `/guild invite` |
| `war` | Canal dos pings de guerra |
| `tome` | Canal da fila de Tomes |
| `loans` | Canal/registro de empréstimos |
| `logs` | Canal de auditoria (ações do bot, votos, concessões, etc.) |

### Chaves de cargos
| Chave | Uso |
|---|---|
| `community` | Acesso à comunidade após `/link` |
| `war` / `mainWar` | Podem disparar ping de guerra (mainWar = prioridade) |
| `recruiters` | Recebem o ping de recrutamento |
| Ranks da guilda | `owner`, `chief`, `strategist`, `captain`, `recruiter`, `recruit` — mapeados 1:1 para cargos do Discord |

### Parâmetros
| Chave | Padrão | Uso |
|---|---|---|
| `guildPrefix` | — | TAG da guilda na API |
| `voteWindowHours` | `24` | Prazo da votação |
| `voteRule` | `effective` | Regra de aprovação (ver §6) |
| `snapshotCron` | diário | Frequência do snapshot de progresso |
| `roleSyncCron` | ~10 min | Frequência do sync de cargos |
| `tomeWeights` | `{contrib, wars, raids}` | Pesos do score de prioridade |

### Comandos de admin
- `/config set-channel <chave> #canal`
- `/config set-role <chave> @cargo`
- `/config set-param <chave> <valor>`
- `/config show` — lista a configuração atual

## 5. Módulo: Linking (nick + confiança)

Fluxo (no canal `registration`):
1. `/link <nick>` → bot busca `/player/<nick>`. Se não existe → erro.
2. Salva `discordId ↔ uuid ↔ username` em `members`.
3. Dá o cargo `community` → acesso aos canais públicos.

Mitigações (sem verificação forte):
- **UUID único:** um UUID não pode estar em dois Discords.
- **Cross-check no ingresso:** quando o polling vê o UUID entrar na guilda, confirma
  o vínculo. Como o recrutador usa `/guild invite <nick>`, quem recebe o convite é o
  **dono real** do nick — impostor não se auto-invita.
- `/unlink <@user|nick>` para staff corrigir.

## 6. Módulo: Candidatura + Votação

Fluxo:
1. `/apply` (precisa estar linkado e **fora** da guilda).
2. Bot posta embed no canal `applications` com botões **Aprovar / Reprovar / Abster**.
3. **Eleitores** = Owner + Chiefs, buscados ao vivo da API e mapeados via link.
   Só eles votam (checagem de cargo/rank no clique).
4. **Prazo** = `voteWindowHours` (`expiresAt`). Um cron fecha e apura.
5. **Aprovado** → ping em `recruiters` com o nick e botão "Copiar comando"
   (`/guild invite <nick>`).

### Regra de aprovação (`voteRule`) — CONFIRMAR
Duas leituras da frase original. Padrão adotado no doc = **`effective`**:

- **`effective`** (padrão): aprovado se `Aprovar > 50%` dos **votos efetivos**
  (`Aprovar + Reprovar`); abstenções saem do cálculo. Respeita "abstenção não
  conta para reprovação".
- **`total`** (alternativa): aprovado se `Aprovar > 50%` do **total de Chiefs**
  elegíveis. Aqui abstenção acaba pesando contra aprovação.

> Decisão pendente do dono do projeto. Também definir empate/quórum mínimo no
> fim do prazo (padrão sugerido: sem maioria de aprovação → reprovado).

## 7. Módulo: Sync de cargos (automático)

Cron `roleSyncCron`:
1. Busca a guilda na API.
2. Para cada membro, casa `uuid` com o link e atribui o cargo do rank
   (`owner`/`chief`/`strategist`/`captain`/`recruiter`/`recruit`).
3. Remove cargos de rank de quem saiu da guilda.

`community` é independente (vem do `/link`). `war`/`mainWar` são **manuais**.

## 8. Módulo: Progresso + Guerras lutadas pela guilda

### Snapshot diário
Cron `snapshotCron`: para cada membro linkado que está na guilda, salva um snapshot
com `globalData` (wars, raids, dungeons, mobsKilled, totalLevel, playtime, quests…)
+ `contributed` (XP da guilda). Guardado em `progressSnapshots` (série temporal por `uuid`).

### Guerras lutadas **pela** guilda
Regra central pedida:
- A cada snapshot diário, `deltaWars = wars(hoje) − wars(ontem)`.
- Se `deltaWars > 0` **e o UUID está na guilda no momento do snapshot**, soma
  `deltaWars` ao placar `guildWars` do membro.
- Guardas: ignora delta negativo ou absurdo (troca de nick/UUID); rastreia por `uuid`,
  nunca por nome.

### Progresso "na guilda"
Para qualquer métrica: `valor_atual − valor_no_ingresso` (baseline = primeiro snapshot
após entrar). Assim contabilizamos todo o progresso feito enquanto membro.

### Leaderboard por Season
Placar competitivo por temporada, registrando **todos** que lutaram pela guilda no período.

> Nota técnica: a API **não** entrega guerras por membro por season (`seasonRanks`
> é o rating da guilda inteira, e nem vem por padrão). Então este leaderboard é
> **construído por nós** a partir dos snapshots diários (§8). A API só é usada para
> descobrir/validar as fronteiras da season (endpoint "List guild seasons").

Mecânica:
1. **Fronteiras da season** ficam em `seasons` (`seasonId`, `startAt`, `endAt`, `active`).
   - Fonte primária: endpoint de seasons da guilda; fallback: detecção de nova season
     (novo `seasonRank`) ou comando de staff `/season start` / `/season end`.
2. A cada snapshot diário, o `deltaWars` já calculado no §8 é **bucketed pela season
   ativa**, acumulando em `seasonParticipation` por `uuid`:
   `warsFought`, `contributedDelta`, `raidsDelta`.
3. Registro é feito **no momento do snapshot enquanto `inGuild`** — então quem sair no
   meio da season continua no placar daquele período (histórico preservado).

Comandos:
- `/leaderboard season [id]` — ranking da season (padrão: ativa) por `warsFought`
  (com desempate/exibição por contribuição). Mostra todos com `warsFought > 0`.
- `/leaderboard all-time` — placar acumulado (`members.guildWars`).
- `/season current` / `/season list` — info das temporadas.
- `/season start|end` (staff) — ajuste manual de fronteira, se necessário.

Casos de borda: delta negativo/absurdo ignorado (troca de nick/UUID); membro que entra
no meio da season só acumula a partir do ingresso; virada de season fecha o bucket
anterior e abre o novo.

## 9. Módulo: Pings de guerra (manual)

`/war` (ou botão fixo no canal `war`), restrito a `war`/`mainWar`:
- Dispara ping no canal/cargo de guerra.
- Contagem de presença opcional ("vou / não vou").
- `mainWar` pode ter ping de prioridade / iniciar a convocação.

> Nota técnica: a API **não** entrega evento de guerra em tempo real; por isso o
> ping é manual. O placar de guerras (§8) é o lado automático/diário.

## 10. Módulo: Fila de Tomes (prioridade por contribuição)

- `/tome join` — entra na fila.
- `/tome queue` — mostra ordenada por score.
- `/tome grant <player>` (staff) — retira o topo e registra a concessão.

**Score de prioridade** (pesos em `tomeWeights`, configuráveis):
```
score = w_contrib · contribuição_na_guilda
      + w_wars    · guildWars
      + w_raids   · raids_na_guilda
```
Reflete "quem mais beneficiou a guilda". Métricas vêm do §8.

## 11. Módulo: Empréstimos (ledger de confiança)

Registro em `loans`: devedor, tipo (`emeralds` | `item`), quantia/descrição, prazo,
status (`open`/`repaid`/`overdue`).
- Cron manda lembrete perto do vencimento e em atraso.
- `/loan new`, `/loan list`, `/loan repay`.
- Reputação (pagou × caloteou) pode, opcionalmente, influenciar prioridade de tome
  e liberação de novos empréstimos.
- **A transferência real é in-game** — o bot é apenas o livro-razão.

## 12. Modelo de dados (Mongo)

```
members
  discordId, uuid, username, linkedAt, communitySince,
  inGuild (bool), guildRank, joinedGuildAt,
  guildWars (int),            // placar acumulado (§8)
  reputation { repaid, defaulted }

applications
  memberId, uuid, status (open|approved|rejected|expired),
  createdAt, expiresAt,
  votes: [{ voterDiscordId, choice: approve|reject|abstain, at }]

progressSnapshots            // série temporal
  uuid, takenAt, inGuild,
  metrics { wars, raids, dungeons, mobsKilled, totalLevel, playtime, contributed, ... }

seasons
  seasonId, startAt, endAt (null se ativa), active (bool), source (api|manual)

seasonParticipation           // um doc por (seasonId, uuid)
  seasonId, uuid, username,
  warsFought (int), contributedDelta, raidsDelta,
  joinedGuildDuringSeason (bool), lastUpdatedAt

tomeQueue
  uuid, joinedQueueAt, scoreCache

loans
  borrowerUuid, type (emeralds|item), amount|itemDesc,
  createdAt, dueAt, status, remindersSent, notes

config                       // um por guilda do Discord
  guildDiscordId, guildPrefix,
  channels { registration, applications, recruiters, war, tome, loans, logs },
  roles { community, war, mainWar, recruiters, owner, chief, strategist, captain, recruiter, recruit },
  params { voteWindowHours, voteRule, snapshotCron, roleSyncCron, tomeWeights }
```

## 13. Preocupações transversais

- **Rate-limit / cache:** cliente da API com fila e respeito ao `Cache-Control`;
  polling em lote; usar API key.
- **Permissões:** cada comando restrito por cargo (voto = Owner/Chief; guerra =
  war/mainWar; config/tome grant/loan = staff).
- **Auditoria:** toda ação relevante logada no canal `logs`.
- **Robustez do UUID:** todo rastreio é por `uuid`, resistente a troca de nick.

## 14. Roadmap incremental

0. Scaffold + config + cliente da API + conexão Mongo + `/link`
1. Sync de cargos + acesso Comunidade
2. Candidatura + votação + ping de recrutamento
3. Snapshots de progresso + placar de guerras + leaderboard por season (§8)
4. Pings de guerra (manual)
5. Fila de Tomes
6. Empréstimos

## 15. Questões em aberto

- [x] Regra de votação: **`effective`** adotada como padrão (configurável para
      `total` via `/config param key:voteRule`). (§6)
- [x] Empate/quórum: sem maioria de aprovação no fim do prazo → **reprovado**.
- [x] Pesos iniciais do Tome: `{contrib:1, wars:5, raids:3}` (via `/config param`).
- [x] Snapshot: diário, horário UTC configurável (`snapshotHourUTC`, padrão 05:00).
- [x] Fronteiras de season: **controle manual por staff** (`/season start|end`) com
      **fallback automático** (cria season "auto-AAAA-MM" se não houver ativa), para
      nunca perder dados. (§8)
- [x] Desempate do leaderboard: por `warsFought` (guerras). Contribuição/raids
      ficam guardadas em `seasonParticipation` para relatórios futuros.
- [ ] Reputação de empréstimo influencia prioridade de Tome? (ainda **não** ligado;
      a base de dados já registra pagos/atrasados para habilitar depois.)
- [x] Formato da `WYNN_API_KEY`: **`Authorization: Bearer <token>`** (testado; outros
      formatos retornam 400 `MalformedTokenError`). Com chave o limite sobe de
      **50 → 120 req/min**.

## 16. Recursos portados do bot antigo

Mesmo servidor Discord do bot antigo → emojis customizados (barras/esmeraldas)
continuam válidos e podem ser restaurados. Canais reais mapeados nas chaves de
`/config` (panel=`guild-status`, activity=`wnbr-changelogs`, territory=
`atualizações-wynn`, errors=`dev-console`, logs=`logs-discord`, recruiters=
`recrutamento`, applications=`aplicação-war`, war=`war`, tome=`tomes`,
loans=`emprestimos`).

**Implementado (monitoramento — poller `watcher.js` a cada `watcherSeconds`):**
- Painel ao vivo da guilda (mensagem única auto-editada) → canal `panel`.
- Logs de atividade (online/offline+servidor, XP%, guerras, nível, season rank) → `activity`.
- Tracker de território + recursos/h (via `territoryMap.json`) → `territory`.
- Auto-ping de guerra ao ganhar/perder território → `war`.
- `/calc` (conversor de esmeraldas) e erros do bot → canal `errors`.

**Decidido + implementado:**
- Cargos: só **"Membro da Guilda"** automático; ranks (Líder/Chefe/…) NÃO
  automáticos (gestão manual). Rank ainda é registrado no banco.
- **Emojis customizados** restaurados (barras de XP e ícones de esmeralda).

**Concluído também:**
- `/verificar` (comando) + **relatório automático** diário no canal `logs`
  (`verifyHourUTC`).
- `/membros` (lista por cargo + online + inativos ≥ `inactivityDays`).
- `/profile` turbinado (dados ao vivo da API + pontos/guerras rastreados).
- Comando extra ("Other") descartado — o dono não lembrava qual era.

## 17. Sistema de Pontos unificado

Métrica única que alimenta leaderboard, prioridade de Tome e o cargo de Top
Contribuidor. Pontos acumulam por membro (all-time em `guildStats.points` e por
season em `seasonParticipation.points`).

**Fontes automáticas** (no snapshot diário, a partir dos deltas — §8):
```
pontos += Δguerras · pesos.war
        + Δraids   · pesos.raid
        + (Δcontribuição / 1.000.000) · pesos.contribPerMillion
```
Pesos padrão (configuráveis em `/config param key:pointsWeights`):
`{ war: 10, raid: 5, contribPerMillion: 1 }`.

**Fontes manuais** (staff): `/points add <user> <amount> <reason>` — para eventos
da guilda, bônus, penalidades (valor negativo). Registrado em `pointsLog`.

**Comandos:** `/points show|leaderboard|add`. **Cargo Top Contribuidor** é
atribuído aos `topContributorCount` maiores em pontos (via roleSync). **Tome**
prioriza por pontos.
