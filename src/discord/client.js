import { Client, GatewayIntentBits, Partials } from 'discord.js';

// GuildMembers é um intent PRIVILEGIADO — habilite no Developer Portal
// (Bot > Privileged Gateway Intents). Necessário para o sync de cargos.
// GuildMessages não é privilegiado e serve só para limpar o canal de registro;
// não lemos conteúdo, então MessageContent continua desnecessário.
// GuildMessageReactions (não privilegiado) alimenta o reaction-role dos pings.
//
// Reações num painel publicado antes deste boot chegam com a mensagem/reação/
// usuário em cache parcial: os partials abaixo deixam o handler dar .fetch().
export function createClient() {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.GuildMember, Partials.Message, Partials.Reaction, Partials.User],
  });
}
