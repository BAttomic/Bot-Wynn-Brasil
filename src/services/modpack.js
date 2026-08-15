import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { optional } from '../config/env.js';
import { zip } from '../util/zip.js';
import { log } from '../util/log.js';

// Modpack que se atualiza sozinho.
//
// Antes: um `mods.rar` commitado no repo, com jars congelados no dia em que
// alguém montou o pacote. Atualizar era baixar tudo na mão, refazer o rar,
// commitar 27 MB e pedir para a guilda inteira baixar de novo — e ninguém
// baixava, então metade dos membros jogava com Wynntils de duas versões atrás.
//
// Agora: o manifesto (src/data/modpack.json) lista os mods por SLUG do Modrinth,
// e um job diário resolve a versão mais recente de cada um e gera dois arquivos:
//
//   .mrpack — o formato de modpack do Modrinth: um zip de poucos KB que só
//             APONTA para os jars (URL do CDN + hash + tamanho). Instalado pelo
//             Modrinth App / Prism / ATLauncher, o launcher oferece "atualizar"
//             sozinho quando a versão do pack muda. É o caminho recomendado, e
//             é também o certo do ponto de vista de licença: referencia os jars
//             em vez de redistribuí-los.
//   .zip    — os jars de verdade, para quem não usa launcher alternativo. Sempre
//             atualizado, mas a instalação continua manual.
//
// A versão do Minecraft é FIXA no manifesto, de propósito: seguir "a última" faria
// o pack pular para o 1.21.12 no dia em que ele saísse, quebrando todo mundo que
// ainda não atualizou o jogo. Subir de versão é uma decisão da staff, um commit.

const MODRINTH = 'https://api.modrinth.com/v2';
const FABRIC_META = 'https://meta.fabricmc.net/v2/versions/loader';

// A Modrinth pede um User-Agent que identifique quem chama (e aperta o rate
// limit de quem não manda nenhum).
const UA = 'battomic/bot-wynn-brasil (bot.battomic.com)';

export const MRPACK_FILE = 'wynn-brasil.mrpack';
export const ZIP_FILE = 'mods.zip';
const STATE_FILE = 'modpack.json';

/**
 * Pasta dos arquivos gerados. Fora de src/assets/ de propósito: aquilo entra na
 * imagem Docker e vem do git, isto é gerado em runtime e precisa de volume para
 * sobreviver ao redeploy (ver docker-compose.yml).
 */
export function dataDir() {
  // `||` e não `??`: `DATA_DIR=` no .env vira string vazia, não undefined, e o
  // `??` do optional() aceitaria isso como caminho válido.
  const dir = optional('DATA_DIR', '') || join(process.cwd(), 'data');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** @returns {{name: string, summary: string, minecraft: string, loader: string, mods: Array<{slug: string, name?: string, allowBeta?: boolean}>}} */
function readManifest() {
  const path = fileURLToPath(new URL('../data/modpack.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  return res.json();
}

/**
 * Escolhe a versão que entra no pack para um mod.
 *
 * Só **release** por padrão. Isso importa de verdade: no dia em que escrevi
 * isto, a versão mais recente do Sodium para o 1.21.11 era uma beta — sem o
 * filtro, o pack oficial da guilda distribuiria beta para todo mundo. Um mod que
 * só publique beta para a versão nova do jogo pode liberar com
 * `"allowBeta": true` no manifesto.
 *
 * @param {{slug: string, name?: string, allowBeta?: boolean}} mod
 * @param {{minecraft: string, loader: string}} manifest
 */
async function resolveMod(mod, manifest) {
  const q = new URLSearchParams({
    loaders: JSON.stringify([manifest.loader]),
    game_versions: JSON.stringify([manifest.minecraft]),
  });
  const versoes = await fetchJson(`${MODRINTH}/project/${mod.slug}/version?${q}`);
  // A API já devolve da mais nova para a mais antiga, mas isso não é contrato.
  const ordenadas = [...versoes].sort(
    (a, b) => new Date(b.date_published) - new Date(a.date_published),
  );
  const escolhida = ordenadas.find((v) => v.version_type === 'release')
    ?? (mod.allowBeta ? ordenadas[0] : null);
  if (!escolhida) {
    throw new Error(
      `${mod.slug}: nenhuma release para ${manifest.loader} ${manifest.minecraft}` +
      `${ordenadas.length ? ' (só beta/alpha — libere com "allowBeta": true se for o caso)' : ''}`,
    );
  }
  const arquivo = escolhida.files.find((f) => f.primary) ?? escolhida.files[0];
  if (!arquivo) throw new Error(`${mod.slug}: versão ${escolhida.version_number} não tem arquivo`);
  return {
    slug: mod.slug,
    name: mod.name ?? mod.slug,
    version: escolhida.version_number,
    type: escolhida.version_type,
    filename: arquivo.filename,
    url: arquivo.url,
    size: arquivo.size,
    sha1: arquivo.hashes?.sha1,
    sha512: arquivo.hashes?.sha512,
  };
}

/** Última versão ESTÁVEL do Fabric Loader, que o .mrpack declara como dependência. */
async function fabricLoaderVersion() {
  const lista = await fetchJson(FABRIC_META);
  const estavel = lista.find((v) => v.stable) ?? lista[0];
  if (!estavel?.version) throw new Error('meta do Fabric não devolveu nenhuma versão');
  return estavel.version;
}

/** Baixa um jar e confere o sha1 que a Modrinth prometeu (CDN não é infalível). */
async function baixar(mod) {
  const res = await fetch(mod.url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`download de ${mod.filename}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sha1 = createHash('sha1').update(buf).digest('hex');
  if (mod.sha1 && sha1 !== mod.sha1) {
    throw new Error(`sha1 não confere em ${mod.filename} (esperado ${mod.sha1}, veio ${sha1})`);
  }
  return buf;
}

function indexJson(manifest, mods, packVersion, loaderVersion) {
  return {
    formatVersion: 1,
    game: 'minecraft',
    versionId: packVersion,
    name: manifest.name,
    summary: manifest.summary,
    files: mods.map((m) => ({
      path: `mods/${m.filename}`,
      hashes: { sha1: m.sha1, sha512: m.sha512 },
      // São todos mods de cliente: o servidor é o WynnCraft, que não é nosso.
      env: { client: 'required', server: 'unsupported' },
      downloads: [m.url],
      fileSize: m.size,
    })),
    dependencies: {
      minecraft: manifest.minecraft,
      'fabric-loader': loaderVersion,
    },
  };
}

/** Grava por arquivo temporário + rename, para o HTTP nunca servir um pacote pela metade. */
function gravar(dir, nome, buf) {
  const destino = join(dir, nome);
  const tmp = `${destino}.tmp`;
  writeFileSync(tmp, buf);
  renameSync(tmp, destino);
}

let estado = null; // cache em memória do STATE_FILE

/**
 * O que está publicado agora: versão do pack, quando foi gerado e a lista de
 * mods com suas versões. Lido do disco na primeira chamada depois de um restart.
 * @returns {null | {packVersion: string, builtAt: string, minecraft: string, loader: string, loaderVersion: string, digest: string, mods: Array<object>}}
 */
export function modpackState() {
  if (estado) return estado;
  const path = join(dataDir(), STATE_FILE);
  if (!existsSync(path)) return null;
  try {
    estado = JSON.parse(readFileSync(path, 'utf8'));
    return estado;
  } catch (e) {
    log.warn('Estado do modpack ilegível, será regerado:', e.message);
    return null;
  }
}

/** Compara a lista nova com a publicada. @returns {Array<{name: string, from: string|null, to: string}>} */
function diffMods(anterior, atual) {
  const antes = new Map((anterior?.mods ?? []).map((m) => [m.slug, m.version]));
  return atual
    .filter((m) => antes.get(m.slug) !== m.version)
    .map((m) => ({ name: m.name, from: antes.get(m.slug) ?? null, to: m.version }));
}

/**
 * Resolve as versões mais recentes e regera os arquivos quando algo mudou.
 *
 * Idempotente: se nenhuma versão mudou e os dois arquivos estão no lugar, não
 * baixa nem escreve nada — o que também significa que rodar isto no boot, a
 * cada restart, é barato (7 chamadas à API e pronto).
 *
 * @param {{force?: boolean}} [opts] `force` regera mesmo sem mudança
 * @returns {Promise<{state: object, changed: Array<{name: string, from: string|null, to: string}>}>}
 */
export async function refreshModpack({ force = false } = {}) {
  const manifest = readManifest();
  const dir = dataDir();

  // Sequencial de propósito: são 7 chamadas uma vez por dia, e em rajada a
  // Modrinth responde 429.
  const mods = [];
  for (const mod of manifest.mods) mods.push(await resolveMod(mod, manifest));

  const digest = createHash('sha1')
    .update(mods.map((m) => `${m.slug}@${m.version}`).join('|'))
    .digest('hex')
    .slice(0, 7);

  const anterior = modpackState();
  const noLugar = existsSync(join(dir, MRPACK_FILE)) && existsSync(join(dir, ZIP_FILE));
  if (!force && anterior?.digest === digest && noLugar) return { state: anterior, changed: [] };

  const mudancas = diffMods(anterior, mods);
  const loaderVersion = await fabricLoaderVersion();
  const agora = new Date();
  const dia = agora.toISOString().slice(0, 10).replace(/-/g, '.');
  const packVersion = `${manifest.minecraft}+${dia}.${digest}`;

  const indice = Buffer.from(
    JSON.stringify(indexJson(manifest, mods, packVersion, loaderVersion), null, 2),
    'utf8',
  );
  gravar(dir, MRPACK_FILE, zip([{ name: 'modrinth.index.json', data: indice, store: false }], agora));

  // O .zip é o caminho caro (baixa ~32 MB de jar). Se ele falhar, o .mrpack já
  // está no disco e continua servindo — que é justamente o link recomendado.
  const jars = [];
  for (const mod of mods) jars.push({ name: mod.filename, data: await baixar(mod) });
  gravar(dir, ZIP_FILE, zip(jars, agora));

  estado = {
    packVersion,
    builtAt: agora.toISOString(),
    minecraft: manifest.minecraft,
    loader: manifest.loader,
    loaderVersion,
    digest,
    mods: mods.map(({ slug, name, version, type, filename, size }) => ({
      slug, name, version, type, filename, size,
    })),
  };
  gravar(dir, STATE_FILE, Buffer.from(JSON.stringify(estado, null, 2), 'utf8'));

  const tamanho = jars.reduce((s, j) => s + j.data.length, 0);
  log.info(
    `Modpack gerado: ${packVersion} — ${mods.length} mods, zip com ${(tamanho / 1e6).toFixed(1)} MB` +
    `${mudancas.length ? ` (${mudancas.length} atualizado(s))` : ''}`,
  );
  return { state: estado, changed: mudancas };
}
