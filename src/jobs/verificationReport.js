import { computeVerification, verificationEmbed } from '../services/verification.js';
import { getConfig } from '../config/guildConfig.js';
import { optional } from '../config/env.js';

// Relatório automático de verificação, postado no canal de logs.
export async function runVerificationReport(client) {
  const gid = optional('DISCORD_GUILD_ID');
  if (!gid) return;
  const cfg = await getConfig(gid);
  const channelId = cfg.channels?.logs;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;
  const data = await computeVerification();
  if (!data) return;
  await channel.send({ embeds: [verificationEmbed(data)] });
}
