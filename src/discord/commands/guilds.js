import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { addGuild, removeGuild, listGuilds, KIND_BLACKLIST, KIND_ALLY } from '../../services/guildList.js';
import { ensureAllyRole, allyRoleName } from '../../services/allyRoles.js';
import { applyReconciliation } from '../../services/reconciliation.js';
import { getConfig } from '../../config/guildConfig.js';
import { collections } from '../../db/mongo.js';
import { brDateTime } from '../../util/format.js';
import { audit } from '../../services/audit.js';

/**
 * Guildas que o bot rastreia, em dois papéis opostos.
 *
 * **Black-list** faz o que a GsW fazia sozinha e fixada no código: quem for
 * membro dela leva o cargo de banido, em silêncio, no registro e a cada ciclo do
 * sync de cargos.
 *
 * **Aliada** é o contrário: ganha um cargo `[TAG] Nome` próprio, entre o cargo
 * de membro da Wynn Brasil e o de comunidade, distribuído a quem estiver nela.
 *
 * A discrição da black-list é regra, não estilo: as respostas daqui são
 * ephemeral e NÃO passam pela auditoria. Um print do canal de logs mostrando
 * "fulano adicionou a guilda X à black-list" entrega a regra inteira, e aí basta
 * sair da guilda antes de se registrar para escapar dela. Mexer em aliadas é
 * público — é uma decisão que a comunidade deve mesmo ver.
 */

const APLICAR_SCOPE = { [KIND_BLACKLIST]: 'banned', [KIND_ALLY]: 'ally' };

async function isStaff(interaction) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  const { params } = await getConfig(interaction.guildId);
  const roles = Array.isArray(params?.voterRoles) ? params.voterRoles : [];
  return roles.some((id) => interaction.member?.roles?.cache?.has(id));
}

const tagOption = (o) =>
  o.setName('tag').setDescription('TAG da guilda no WynnCraft (ex.: GsW)').setRequired(true);

function grupo(g, name, description, addDesc, removeDesc, listDesc) {
  return g
    .setName(name)
    .setDescription(description)
    .addSubcommand((s) => s.setName('add').setDescription(addDesc).addStringOption(tagOption))
    .addSubcommand((s) => s.setName('remove').setDescription(removeDesc).addStringOption(tagOption))
    .addSubcommand((s) => s.setName('list').setDescription(listDesc));
}

export default {
  data: new SlashCommandBuilder()
    .setName('guilds')
    .setDescription('(Staff) Guildas rastreadas: black-list e aliadas')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommandGroup((g) =>
      grupo(
        g,
        'blacklist',
        'Guildas cujos membros levam o cargo de banido',
        'Adiciona uma guilda à black-list pela TAG',
        'Tira uma guilda da black-list',
        'Mostra as guildas da black-list',
      ),
    )
    .addSubcommandGroup((g) =>
      grupo(
        g,
        'ally',
        'Guildas aliadas: ganham um cargo [TAG] Nome no servidor',
        'Adiciona uma guilda aliada pela TAG e cria o cargo dela',
        'Tira uma guilda da lista de aliadas',
        'Mostra as guildas aliadas',
      ),
    )
    .addSubcommand((s) =>
      s.setName('list').setDescription('Mostra TODAS as guildas rastreadas: black-list e aliadas'),
    )
    .toJSON(),

  async execute(interaction) {
    // `false` porque `/guilds list` é um subcomando de topo, sem grupo.
    const kind = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    // A black-list nunca aparece em canal público, nem por um instante.
    await interaction.deferReply({ ephemeral: true });
    if (!(await isStaff(interaction))) {
      return interaction.editReply('Apenas a staff pode ver ou mexer nas guildas rastreadas.');
    }

    if (!kind) return list(interaction, null); // /guilds list
    if (sub === 'list') return list(interaction, kind);
    if (sub === 'add') return add(interaction, kind);
    return remove(interaction, kind);
  },
};

/**
 * Quem adicionou, dos dois lados da identidade: a menção do Discord (clicável) e
 * o nick do WynnCraft, quando essa pessoa tem vínculo. Um `<@id>` sozinho vira
 * um id cru se a pessoa saiu do servidor — e é justamente aí que saber quem foi
 * importa mais.
 * @returns {Promise<Map<string, string>>} discordId -> nick
 */
async function nicksDeQuemAdicionou(guildas) {
  const ids = [...new Set(guildas.map((g) => g.addedBy).filter(Boolean))];
  if (!ids.length) return new Map();
  const docs = await collections
    .members()
    .find({ discordId: { $in: ids } }, { projection: { discordId: 1, username: 1 } })
    .toArray();
  return new Map(docs.map((d) => [d.discordId, d.username]));
}

function linhaDaGuilda(g, nicks, { comCargo }) {
  const partes = [`• **[${g.prefix}]** ${g.name}`];
  if (comCargo) partes.push(g.roleId ? `<@&${g.roleId}>` : '*sem cargo ainda*');

  const nick = g.addedBy ? nicks.get(g.addedBy) : null;
  const quem = g.addedBy
    ? `<@${g.addedBy}>${nick ? ` (\`${nick}\`)` : ''}`
    : '*origem desconhecida*';

  // Data em horário de Brasília, fixo: isto é registro do que aconteceu, e o
  // `<t:…>` do Discord mostraria uma hora diferente para cada leitor.
  return `${partes.join(' · ')}\n  ↳ por ${quem} em ${brDateTime(g.addedAt)}`;
}

async function list(interaction, kind) {
  // `kind === null` é o `/guilds list`: mostra os dois papéis de uma vez.
  const blacklist = kind === KIND_ALLY ? [] : await listGuilds(KIND_BLACKLIST);
  const aliadas = kind === KIND_BLACKLIST ? [] : await listGuilds(KIND_ALLY);

  if (!blacklist.length && !aliadas.length) {
    const dica =
      kind === KIND_BLACKLIST
        ? 'Nenhuma guilda na black-list — **o auto-ban está inativo**. Use `/guilds blacklist add tag:<TAG>`.'
        : kind === KIND_ALLY
          ? 'Nenhuma guilda aliada. Use `/guilds ally add tag:<TAG>`.'
          : 'Nenhuma guilda rastreada ainda. Use `/guilds blacklist add` ou `/guilds ally add`.';
    return interaction.editReply(dica);
  }

  const nicks = await nicksDeQuemAdicionou([...blacklist, ...aliadas]);
  const fields = [];

  if (blacklist.length) {
    fields.push({
      name: `🚫 Black-list (${blacklist.length})`,
      value: blacklist.map((g) => linhaDaGuilda(g, nicks, { comCargo: false })).join('\n').slice(0, 1024),
    });
  } else if (kind === null) {
    fields.push({ name: '🚫 Black-list (0)', value: '*vazia — o auto-ban está inativo.*' });
  }

  if (aliadas.length) {
    fields.push({
      name: `🤝 Aliadas (${aliadas.length})`,
      value: aliadas.map((g) => linhaDaGuilda(g, nicks, { comCargo: true })).join('\n').slice(0, 1024),
    });
  } else if (kind === null) {
    fields.push({ name: '🤝 Aliadas (0)', value: '*nenhuma.*' });
  }

  return interaction.editReply({
    embeds: [
      {
        title: '📋 Guildas rastreadas',
        color: blacklist.length && !aliadas.length ? 0xe74c3c : 0x9b59b6,
        fields,
        footer: {
          text: 'Black-list: cargo de banido, sem aviso nenhum. Aliada: cargo [TAG] Nome + comunidade.',
        },
        timestamp: new Date().toISOString(),
      },
    ],
    allowedMentions: { parse: [] },
  });
}

async function add(interaction, kind) {
  const tag = interaction.options.getString('tag', true);
  const res = await addGuild({ tag, kind, by: interaction.user.id });
  if (!res.ok) return interaction.editReply(res.error);

  const { guild: doc, created, movedFrom } = res;
  const linhas = [];

  if (created) {
    linhas.push(
      kind === KIND_BLACKLIST
        ? `🚫 **[${doc.prefix}] ${doc.name}** entrou na black-list.`
        : `🤝 **[${doc.prefix}] ${doc.name}** entrou na lista de aliadas.`,
    );
  } else if (movedFrom) {
    linhas.push(`♻️ **[${doc.prefix}] ${doc.name}** mudou de **${movedFrom}** para **${kind}**.`);
  } else {
    linhas.push(`**[${doc.prefix}] ${doc.name}** já estava na lista — dados atualizados.`);
  }

  // O cargo da aliada nasce aqui, e não no próximo ciclo do sync: a staff
  // precisa ver o resultado do próprio comando.
  if (kind === KIND_ALLY) {
    const cfg = await getConfig(interaction.guildId);
    const roleId = await ensureAllyRole(interaction.guild, cfg, doc);
    if (roleId) {
      linhas.push(`Cargo <@&${roleId}> pronto.`);
    } else {
      linhas.push(
        `⚠️ Não consegui criar o cargo **${allyRoleName(doc)}**. Confira se o cargo do bot está acima do cargo de comunidade e se \`/config role key:community\` está preenchido.`,
      );
    }
  }

  // Aplica de imediato a quem já está no servidor. É o mesmo caminho do painel
  // de reconciliação, então a regra é uma só.
  const scope = APLICAR_SCOPE[kind];
  const { applied } = await applyReconciliation(interaction.guild, scope);
  linhas.push(
    applied
      ? `**${applied}** membro(s) do servidor já foram atualizados.`
      : 'Ninguém no servidor precisou de ajuste agora.',
  );

  if (kind === KIND_ALLY) {
    await audit(
      interaction.client,
      interaction.guildId,
      `🤝 <@${interaction.user.id}> adicionou **[${doc.prefix}] ${doc.name}** às guildas aliadas.`,
    );
  }

  return interaction.editReply({ content: linhas.join('\n'), allowedMentions: { parse: [] } });
}

async function remove(interaction, kind) {
  const tag = interaction.options.getString('tag', true);
  const res = await removeGuild({ tag, kind });
  if (!res.ok) return interaction.editReply(res.error);

  const doc = res.guild;
  const linhas = [`**[${doc.prefix}] ${doc.name}** saiu da lista de ${kind === KIND_BLACKLIST ? 'black-list' : 'aliadas'}.`];

  if (kind === KIND_BLACKLIST) {
    // Sair da black-list NÃO desbane ninguém, e isso é deliberado: o banimento é
    // permanente por decisão da staff (ver services/bans.js). Quem for perdoado
    // sai pelo /ban remove, um a um, depois de apelação.
    linhas.push(
      '-# Os banimentos já gravados continuam valendo — a lista de bans é permanente. Use `/ban remove` para isentar caso a caso.',
    );
  } else {
    // O cargo fica de pé, e com ele quem já o tinha. Apagar um cargo é
    // irreversível e é a staff que decide — mas é também o jeito certo de tirar
    // de todo mundo de uma vez, já que o Discord remove o cargo de cada membro
    // quando o cargo deixa de existir. Uma varredura de reconciliação aqui não
    // resolveria nada: sem a guilda na lista, o bot nem sabe mais que aquele
    // cargo era de aliada.
    if (doc.roleId) {
      linhas.push(
        `O cargo <@&${doc.roleId}> **não** foi apagado e quem já o tinha continua com ele. Apague o cargo para tirar de todos de uma vez.`,
      );
    }
    linhas.push('O bot para de distribuí-lo a partir de agora.');
    await audit(
      interaction.client,
      interaction.guildId,
      `🤝 <@${interaction.user.id}> removeu **[${doc.prefix}] ${doc.name}** das guildas aliadas.`,
    );
  }

  return interaction.editReply({ content: linhas.join('\n'), allowedMentions: { parse: [] } });
}
