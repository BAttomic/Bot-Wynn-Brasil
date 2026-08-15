# Bot de Guilda WynnCraft

Bot de Discord para gerir uma guilda do WynnCraft. Veja o design completo em
[design.md](design.md).

## Dependências

Apenas duas, de propósito:

- `discord.js` — gateway, REST e slash commands do Discord
- `mongodb` — driver oficial (sem ORM)

HTTP (`fetch`), agendamento e leitura de `.env` usam recursos nativos do Node (>= 20).

## O que já está implementado

Todos os módulos do roadmap. Comandos:

| Comando | Função |
|---|---|
| `/link <nick>` | Vincula conta e dá o cargo de comunidade |
| `/unlink` | (Staff) Remove vínculo |
| `/config channel\|role\|param\|show` | Configura canais, cargos e parâmetros |
| `/apply submit\|status` | Candidatura + votação (24h, cooldown de reaplicação) |
| `/season start\|end\|current\|list` | (Staff) Gerencia temporadas |
| `/leaderboard season\|alltime` | Placar de guerras pela guilda |
| `/profile [nick]` | Progresso acumulado de um membro |
| `/war [nota]` | (WAR/MAIN WAR) Convocação de guerra com presença |
| `/tome join\|leave\|queue\|grant` | Fila de Tomes (prioridade por pontos; 1 Tome por missão semanal, e só vale com 7 dias de guilda) |
| `/loan new\|list\|repay\|cancel` | (Staff) Livro-razão de empréstimos |
| `/points show\|leaderboard\|add` | Sistema de pontos unificado |
| `/calc` | Conversor de esmeraldas (stx/le/eb/em) |
| `/uniforme` | Baixa o uniforme e a capa oficiais da Wynn Brasil |
| `/modpack` | Devolve o modpack oficial, sempre atualizado (`.mrpack` + `.zip`) |
| `/booth registrar\|status\|cancelar` | Lembrete de reset do booth (24h): avisa o dono ~5 min antes, no canal `booth`, com botão de parar |
| `/evento criar\|ranking\|listar\|encerrar\|cancelar\|apurar` | Competição por período: quem mais fizer guild raids, guerras ou XP leva a recompensa |
| `/giveaway criar\|encerrar\|reroll\|listar` | Sorteio com inscrição por botão |
| `/guilds list\|blacklist\|ally` | (Staff) Guildas rastreadas: black-list (auto-ban) e aliadas (cargo `[TAG] Nome`), com quem adicionou e quando |

Automático (jobs):
- **Sync de cargos**: cargo "Membro da Guilda" + "Top Contribuidor" (ranks são manuais) + reconciliação de ingresso/saída
- **Monitoramento em tempo real** (poller ~60s): painel ao vivo (`panel`), logs de atividade (`activity`), território + recursos (`territory`) e **auto-ping de guerra**
- **Expiração de candidaturas** (fecha e apura no prazo)
- **Snapshot diário**: progresso, placar de guerras e **pontos** (all-time + por season)
- **Lembretes de empréstimo** (a vencer / atrasados). As cobranças somem do canal
  48h depois de o empréstimo fechar — o **tópico** com o acordo fica, é o registro
- **Check-in de inatividade**: quem estoura a margem recebe **uma** DM com dois
  botões antes de qualquer expulsão (ver abaixo)
- **Eventos e sorteios**: painel do evento se atualiza sozinho, o evento fecha e
  anuncia o pódio no prazo, e o sorteio é apurado no minuto do vencimento
- **Modpack**: remonta o pack a cada 6h com a versão mais recente de cada mod
  (ver abaixo)
- **Auditoria** (`logs`) e **erros do bot** (`errors`)

## Guildas rastreadas

O bot acompanha guildas do WynnCraft em dois papéis opostos, adicionadas **pela
TAG** e guardadas no banco — mexer nelas não exige redeploy.

```
/guilds blacklist add tag:GsW      # membros dela levam o cargo de banido
/guilds ally      add tag:HAX      # membros dela ganham o cargo [HAX] Nome
/guilds ally      remove tag:HAX
/guilds list                       # os dois papéis, com quem adicionou e quando
```

`/guilds list` mostra tudo de uma vez; `/guilds blacklist list` e
`/guilds ally list` mostram um papel só. Cada linha traz a TAG, o nome, o cargo
(nas aliadas), **quem adicionou** — menção do Discord e o nick do WynnCraft, se a
pessoa tiver vínculo — e a data em **horário de Brasília (UTC-3)**, fixa. O
`<t:…>` do Discord não serve aqui: ele renderiza no fuso de quem lê, e dois
membros da staff veriam horas diferentes para o mesmo registro.

| Papel | O que acontece com quem for membro |
|---|---|
| **black-list** | Recebe o cargo de banido no registro, no `/reconciliar` e a cada ciclo do sync de cargos. **Em silêncio** — nenhuma mensagem, em canal nenhum |
| **aliada** | Recebe o cargo de comunidade **mais** um cargo `[TAG] Nome`, criado pelo bot logo abaixo do cargo de membro da guilda e logo acima do de comunidade |

O `add` já aplica aos membros que estão no servidor; não é preciso esperar o
próximo ciclo. A identificação é pelo **UUID** da guilda, não pela TAG: trocar a
TAG no jogo não escapa da regra nem quebra o cargo de aliada — o cargo é
renomeado sozinho no ciclo seguinte.

**Tirar uma guilda da black-list não desbane ninguém.** Os banimentos já
gravados são permanentes por decisão de projeto (ver `services/bans.js`); quem
for perdoado sai pelo `/ban remove`, caso a caso. E `ally remove` **não apaga** o
cargo do Discord — ele só para de ser distribuído; apagar o cargo é o que tira de
todos de uma vez.

A black-list **não tem nada embutido**: nem no código, nem no `.env`. Servidor
novo (ou banco novo) sobe com a lista vazia e sem banir ninguém — o bot avisa no
log. Rode `/guilds blacklist add tag:<TAG>` uma vez e pronto.

## Check-in de inatividade

Ninguém é expulso sem ser perguntado. Quando um membro estoura a **própria**
margem (`inactivityDays` + o perdão que os pontos de contribuição compram), o bot
manda **uma** DM com dois botões:

| Botão | O que acontece |
|---|---|
| 🎮 **Ainda quero jogar** | Ganha `inactivityReturnDays` (3) para **entrar no jogo**. Um login zera o contador e encerra o assunto |
| 👋 **Perdi o interesse** | O slot é liberado; o nick vai para a lista de kick na hora |
| *(sem resposta)* | Passadas `inactivityCheckHours` (24), o silêncio conta como desinteresse |

**Quantas mensagens?** No máximo **duas** por episódio de inatividade:

1. o check-in acima, quando a margem estoura;
2. só para quem clicou em *ainda quero jogar* e deixou os 3 dias passarem sem
   logar — avisando que o nick caiu na lista, que a expulsão não é automática e
   que um login ainda tira o nome de lá.

Quem simplesmente não responde **não** recebe a segunda: silêncio já é resposta, e
insistir é exatamente o que a primeira mensagem promete não fazer.

A mensagem reforça o motivo da regra: o kick por inatividade existe **só** para
liberar slot para quem está jogando. Não é banimento, não fica no histórico, e o
membro pode voltar quando quiser refazendo o processo de entrada.

O resultado sai no **`/verificar`** (e no relatório diário do canal `logs`), num
bloco pronto para copiar e colar no jogo:

```
/gu kick Fulano
/gu kick Ciclano
```

Quem ainda tem prazo correndo aparece numa lista separada, com o que se espera de
cada um (clicar ou logar) e até quando — para a staff não expulsar antes da hora.

Nunca entram na lista: quem voltou a jogar, quem a contribuição ainda protege, e
quem sequer foi perguntado. Quem não tem vínculo no Discord (ou está com a DM
fechada) entra direto, com o motivo à mostra — não há como perguntar.

| Parâmetro | Padrão | Uso |
|---|---|---|
| `inactivityCheckHours` | `24` | Prazo para clicar num dos botões |
| `inactivityReturnDays` | `3` | Prazo para logar depois de dizer que ainda quer jogar |

## Eventos de competição

`/evento criar` abre uma disputa por um período: durante a janela, o bot
contabiliza numa tabela secundária o quanto cada membro fez da métrica escolhida,
e no fim premia o pódio.

```
/evento criar nome:Corrida de Raids metrica:Guild Raids dias:14 premio:3 LE podio:3 pontos:500
/evento criar nome:Julho de Guerra metrica:Guerras dias:14 premio:2 LE inicio:29/07 00:00
```

| Opção | O que faz |
|---|---|
| `metrica` | `Guild Raids`, `Guerras` ou `XP contribuído` |
| `dias` | Duração (14 = duas semanas). Aceita fração para testes |
| `premio` | Texto livre, mostrado no painel e no anúncio |
| `inicio` | (Opcional) quando abre, **horário de Brasília**. Padrão: agora |
| `podio` | Quantos colocados são premiados (padrão: 1) |
| `pontos` | (Opcional) pontos da guilda para o 1º; cada posição abaixo leva metade |
| `canal` | Onde publicar o painel (padrão: o canal do comando) |

`inicio` aceita `29/07 00:00`, `29/07/2026 00:00` e `2026-07-29 00:00` (sem hora
vira meia-noite). Enquanto não abre, o painel mostra a contagem regressiva e a
tabela fica vazia. Data no passado é recusada.

**Todo mundo começa do zero:** o evento conta só o que for feito depois da
abertura. Nada do que a pessoa já tinha entra.

### Guild Raids: contam no gatilho

O watcher já detecta cada guild raid no instante em que ela termina (poller de
60s, o mesmo que anuncia a raid no canal). O evento é creditado **ali**, uma
unidade para cada membro do grupo — não na apuração do dia seguinte.

É isso que faz um evento marcado para as 00:00 do dia 29 ser exato: a raid que
terminou às 23:58 do dia 28 simplesmente não é creditada.

O preço: raid feita **com o bot fora do ar** não entra no evento. Os pontos
dessa raid não se perdem (a contagem diária recupera pelo `guildRaids` da API),
mas o placar do evento não a enxerga.

### Guerras e XP: contam na janela diária

Essas duas não têm gatilho — só existem como delta da contagem diária
(`progressSnapshot`), então a granularidade é de um dia. A apuração lê a
**janela** do livro-razão de pontos (`pointsEvents`), que já registra quantidade
bruta com data. Por isso reapurar nunca duplica e `/evento apurar` pode rodar à
vontade.

Só que esse delta diário **atravessa a hora da abertura**: o lançamento do dia
seguinte cobre desde a contagem anterior, incluindo horas em que o evento nem
existia. Para não contar esse pedaço, o bot **apura no momento em que o evento
abre** (na criação, ou pelo job de 5 em 5 minutos quando é agendado) e fixa o
corte no instante real dessa apuração. Se a API do Wynncraft estiver fora do ar
na hora, o comando avisa.

### Regras comuns

- A **linha de base** de quem entra na guilda no meio do evento fica de fora.
  Sem isso, um veterano recém-chegado largaria com uma vida inteira de XP e
  venceria sem jogar.
- Empate vai para **quem chegou àquele número primeiro**. Se empatar até no
  instante (comum na contagem diária, que carimba todo mundo com a mesma hora),
  decide o nome — só para o ranking não trocar de posição sozinho entre duas
  atualizações do painel.
- `pontos` entra no livro-razão como concessão manual: aparece no `/profile`,
  conta para a inatividade e é reversível como qualquer outro lançamento.

O painel vive no canal `events` (ou no canal onde o comando foi usado) e se
reconstrói sozinho se alguém apagar a mensagem.

## Sorteios

```
/giveaway criar premio:Mythic horas:48 vagas:2 requisito:Membro da guilda
```

A inscrição é o botão **🎉 Participar** na própria mensagem — clicar de novo
sai do sorteio. Requisitos possíveis: aberto a todos, conta vinculada, membro da
guilda, ou pontos mínimos. O sorteio é apurado no minuto do vencimento; a staff
pode antecipar com `/giveaway encerrar` ou refazer com `/giveaway reroll`
(que exclui quem já ganhou).

## Modpack

O pack **não é mais um arquivo commitado**. A fonte é o manifesto
`src/data/modpack.json`, que lista os mods pelo **slug do Modrinth**:

```json
{
  "minecraft": "1.21.11",
  "loader": "fabric",
  "mods": [{ "slug": "wynntils", "name": "Wynntils" }]
}
```

A cada 6h o bot resolve a **última release** de cada mod para essa versão do
Minecraft e, se algo mudou, regera dois arquivos:

| Arquivo | Para quem | Atualiza sozinho? |
|---|---|---|
| `${PUBLIC_URL}/modpack.mrpack` | Modrinth App, Prism, ATLauncher | **Sim** — o launcher avisa e aplica |
| `${PUBLIC_URL}/modpack` (`.zip`) | quem não usa launcher | Não — baixar de novo na mão |

O `.mrpack` tem ~1,5 KB: ele só aponta para os jars no CDN da Modrinth (URL +
sha1/sha512 + tamanho), então o bot nem hospeda mod nenhum nesse caminho — o que
também evita redistribuir jar de terceiro. O `.zip` (~30 MB) é montado com os
jars baixados e conferidos pelo sha1.

Mexendo no manifesto:

- **Adicionar/remover mod**: edite a lista e suba. O slug é o final da URL do
  Modrinth (`modrinth.com/mod/wynntils` → `wynntils`).
- **Subir a versão do Minecraft**: troque `minecraft`. É decisão da staff, de
  propósito — seguir "a última" automaticamente quebraria todo mundo que ainda
  não atualizou o jogo no dia em que o WynnCraft mudasse de versão.
- **Mod que não publica release?** `"allowPrerelease": true` naquele mod, e ele
  passa a aceitar beta e alpha (o WynnExtras só publica alpha, por exemplo). Sem
  a chave o pack só distribui release — nenhuma guilda quer beta por acidente.

Toda atualização vira uma linha no canal de auditoria (`logs`), com o de/para de
cada mod.

**Quando um mod não tem versão para o `minecraft` fixado**, o pack inteiro deixa
de atualizar — continuar servindo o de ontem, completo, é melhor que publicar um
sem o Wynntils — e o motivo vai para o canal de erros, uma vez por falha e não a
cada passada. É o sinal de que chegou a hora de subir a versão no manifesto (ou
de tirar o mod da lista).

## Ops (VPS / Easypanel)

- **Healthcheck:** HTTP em `:$PORT/health` (use no health check do Easypanel).
- **Download do modpack:** o mesmo servidor HTTP serve o pack em `:$PORT/modpack`
  (`.zip`) e `:$PORT/modpack.mrpack`. Exponha um domínio no Dokploy apontando
  para `:$PORT` e informe-o em `PUBLIC_URL` — o `/modpack` monta os links a
  partir dele. Os arquivos são **gerados em runtime** e vivem em `DATA_DIR`, que
  precisa ser um volume (ver `docker-compose.yml`): sem ele, o redeploy limpa o
  pack e o `/modpack` cai no `mods.rar` legado até o job rodar de novo.
- **Dossiê GsW:** o mesmo servidor abre a página em `:$PORT/gsw` —
  `${PUBLIC_URL}/gsw` no domínio público. É um HTML autocontido (os prints vão
  embutidos em base64), gerado por `gsw/build.ps1` direto em `src/assets/`.
  Editou o texto em `gsw/template.html` ou trocou print em `gsw/img/`? Roda
  `powershell -ExecutionPolicy Bypass -File gsw/build.ps1` e sobe de novo.
- **Backup:** agende `scripts/backup.sh` (mongodump gzip, mantém 14 dias). Veja o
  cabeçalho do script para as variáveis.

## Configuração

Variáveis de ambiente (veja `.env.example`):

| Variável | Descrição |
|---|---|
| `DISCORD_TOKEN` | Token do bot |
| `DISCORD_CLIENT_ID` | Application ID |
| `DISCORD_GUILD_ID` | ID do servidor Discord (registro instantâneo dos comandos) |
| `MONGO_URI` | String de conexão do MongoDB |
| `MONGO_DB` | Nome do banco (padrão: `wynn_guild`) |
| `WYNN_GUILD_PREFIX` | TAG da guilda na API |
| `WYNN_API_KEY` | (Opcional) chave da API v3 |
| `PUBLIC_URL` | Domínio público do bot (links de `/modpack` e `/gsw`) |
| `DATA_DIR` | Onde o modpack gerado é gravado (padrão: `./data`; em produção, o volume) |

### Intent privilegiado

Habilite **Server Members Intent** no
[Developer Portal](https://discord.com/developers/applications) (Bot > Privileged
Gateway Intents) — é necessário para o sync de cargos.

## Rodando local

```bash
npm install
cp .env.example .env   # preencha os valores
npm start
```

Após subir, configure ao menos os cargos de classificação e o canal de registro:

```
/config role key:community    role:@Comunidade
/config role key:guildMember  role:@Membros WnBR
/config role key:banned       role:@BANIDO
/config channel key:registration channel:#registro
```

O cargo do bot precisa estar **acima** do cargo de comunidade na lista de cargos
do servidor: é o que permite criar e posicionar os cargos `[TAG] Nome` das
guildas aliadas. Sem isso o bot avisa no log e segue sem o cargo, em vez de
falhar o registro.

Os cargos de liderança (votam nas candidaturas e podem usar `/forcelink`):

```
/config param key:voterRoles value:["<id_do_cargo>"]
```

## Deploy no Easypanel (VPS própria)

1. **MongoDB:** crie um serviço de MongoDB no Easypanel; copie a connection string
   para `MONGO_URI`.
2. **Bot:** crie um app a partir deste repositório (build via `Dockerfile`).
3. Defina as variáveis de ambiente na aba do app (não precisa de `.env` no servidor).
4. Deploy. Os slash commands se registram sozinhos no start.
