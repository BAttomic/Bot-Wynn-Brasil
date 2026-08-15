/** Fuso em que a staff pensa as datas. O Brasil não tem mais horário de verão. */
export const TIMEZONE = 'America/Sao_Paulo';

/**
 * Data e hora de Brasília, sempre igual para todo mundo.
 *
 * O `<t:…>` do Discord renderiza no fuso de QUEM LÊ, o que é ótimo para prazos
 * ("faltam 2h") e péssimo para registro histórico: dois membros da staff olhando
 * a mesma auditoria veriam horas diferentes. Onde o valor é um carimbo do que
 * aconteceu, o fuso precisa ser fixo.
 *
 * @param {Date|string|number} d
 * @returns {string} ex.: `15/08/2026 17:04 (UTC-3)`
 */
export function brDateTime(d) {
  // `new Date(null)` é o epoch, não uma data inválida — sem esta guarda um campo
  // vazio no banco vira "31/12/1969" em vez de um traço.
  if (d === null || d === undefined || d === '') return '—';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '—';
  const s = new Intl.DateTimeFormat('pt-BR', {
    timeZone: TIMEZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
  return `${s.replace(', ', ' ')} (UTC-3)`;
}

// Barra de progresso em texto (portável — sem emojis customizados de servidor).
export function xpBar(percent, size = 12) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = Math.round((p / 100) * size);
  return '█'.repeat(filled) + '░'.repeat(size - filled);
}

export function shortNumber(num) {
  const suf = ['', 'k', 'M', 'B', 'T', 'P', 'E'];
  let i = 0;
  num = Number(num) || 0;
  while (num >= 1000 && i < suf.length - 1) {
    num /= 1000;
    i++;
  }
  let s = num.toFixed(1);
  if (s.endsWith('.0')) s = s.slice(0, -2);
  return s + suf[i];
}

// Limite de membros por nível de guilda (portado do bot antigo).
export function membersLimit(level) {
  const i = Number(level) || 0;
  return i < 2 ? 4 : i < 6 ? 8 : i < 15 ? 16 : i < 24 ? 26 : i < 33 ? 38 : i < 42 ? 48 : i < 54 ? 60 : i < 66 ? 72 : i < 75 ? 80 : i < 81 ? 86 : i < 87 ? 92 : i < 93 ? 98 : i < 96 ? 102 : i < 99 ? 106 : i < 102 ? 110 : i < 105 ? 114 : i < 108 ? 118 : i < 111 ? 122 : i < 114 ? 126 : i < 117 ? 130 : i < 120 ? 140 : 150;
}

export function calcExperience(level) {
  const base = 20000;
  let xp = 0;
  for (let n = 1; n <= (Number(level) || 0); n++) xp += Math.pow(1.15, n - 1);
  return base * xp;
}

// Acessa um valor por caminho "/a/b/c".
export function getByPath(obj, path) {
  const keys = path.split('/').filter(Boolean);
  let cur = obj;
  for (const k of keys) {
    if (cur && Object.prototype.hasOwnProperty.call(cur, k)) cur = cur[k];
    else return undefined;
  }
  return cur;
}

// Diff recursivo que retorna os caminhos alterados (portado do bot antigo).
export function diffPaths(oldObj, newObj, path = '') {
  let changes = [];
  for (const key in oldObj) {
    if (Object.prototype.hasOwnProperty.call(newObj, key)) {
      const a = oldObj[key];
      const b = newObj[key];
      if (a && b && typeof a === 'object' && typeof b === 'object') {
        changes = changes.concat(diffPaths(a, b, `${path}/${key}`));
      } else if (a !== b) {
        changes.push(`${path}/${key}`);
      }
    } else {
      changes.push(`${path}/${key}`);
    }
  }
  for (const key in newObj) {
    if (!Object.prototype.hasOwnProperty.call(oldObj, key)) changes.push(`${path}/${key}`);
  }
  return changes;
}
