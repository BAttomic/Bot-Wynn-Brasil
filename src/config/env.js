import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Loader de .env sem dependências. Em produção (Easypanel) as variáveis já vêm
// do ambiente, então o arquivo é opcional. Não sobrescreve variáveis já setadas.
export function loadEnv() {
  const path = join(process.cwd(), '.env');
  if (!existsSync(path)) return;
  const content = readFileSync(path, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

export function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return v;
}

export function optional(name, fallback = undefined) {
  return process.env[name] ?? fallback;
}
