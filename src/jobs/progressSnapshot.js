import { takeSnapshots } from '../services/progress.js';

export async function runProgressSnapshot() {
  await takeSnapshots();
}
