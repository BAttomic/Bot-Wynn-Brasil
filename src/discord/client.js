import { Client, GatewayIntentBits, Partials } from 'discord.js';

// GuildMembers é um intent PRIVILEGIADO — habilite no Developer Portal
// (Bot > Privileged Gateway Intents). Necessário para o sync de cargos.
export function createClient() {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    partials: [Partials.GuildMember],
  });
}
