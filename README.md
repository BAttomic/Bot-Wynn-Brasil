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
| `/tome join\|leave\|queue\|grant` | Fila de Tomes (prioridade por pontos) |
| `/loan new\|list\|repay\|cancel` | (Staff) Livro-razão de empréstimos |
| `/points show\|leaderboard\|add` | Sistema de pontos unificado |
| `/calc` | Conversor de esmeraldas (stx/le/eb/em) |
| `/uniforme` | Baixa o uniforme e a capa oficiais da Wynn Brasil |
| `/modpack` | Devolve o link de download do modpack oficial (`mods.rar`) |
| `/booth registrar\|status\|cancelar` | Lembrete de reset do booth (24h): avisa o dono ~5 min antes, no canal `booth`, com botão de parar |

Automático (jobs):
- **Sync de cargos**: cargo "Membro da Guilda" + "Top Contribuidor" (ranks são manuais) + reconciliação de ingresso/saída
- **Monitoramento em tempo real** (poller ~60s): painel ao vivo (`panel`), logs de atividade (`activity`), território + recursos (`territory`) e **auto-ping de guerra**
- **Expiração de candidaturas** (fecha e apura no prazo)
- **Snapshot diário**: progresso, placar de guerras e **pontos** (all-time + por season)
- **Lembretes de empréstimo** (a vencer / atrasados)
- **Auditoria** (`logs`) e **erros do bot** (`errors`)

## Ops (VPS / Easypanel)

- **Healthcheck:** HTTP em `:$PORT/health` (use no health check do Easypanel).
- **Download do modpack:** o mesmo servidor HTTP serve o `mods.rar` em
  `:$PORT/modpack`. Exponha um domínio no Dokploy apontando para `:$PORT` e
  informe-o em `PUBLIC_URL` — o `/modpack` monta o link `${PUBLIC_URL}/modpack`.
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
