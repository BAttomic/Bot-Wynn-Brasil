import { collections } from '../db/mongo.js';
import { finalizeApplication } from '../services/applications.js';

// Fecha candidaturas cujo prazo de votação expirou.
export async function runApplicationExpiry(client) {
  const expired = await collections
    .applications()
    .find({ status: 'open', expiresAt: { $lte: new Date() } })
    .toArray();
  for (const app of expired) {
    await finalizeApplication(client, app._id.toString(), 'deadline');
  }
}
