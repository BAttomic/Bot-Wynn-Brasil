import { Client, GatewayIntentBits, Partials } from 'discord.js';

// GuildMembers é um intent PRIVILEGIADO — habilite no Developer Portal
// (Bot > Privileged Gateway Intents). Necessário para o sync de cargos.
// GuildMessages não é privilegiado e serve só para limpar o canal de registro;
// não lemos conteúdo, então MessageContent continua desnecessário.
export function createClient() {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
    ],
    partials: [Partials.GuildMember],
  });
}
