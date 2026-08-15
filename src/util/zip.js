import { deflateRawSync } from 'node:zlib';

// Escritor de ZIP mínimo, sem dependências.
//
// Existe porque o modpack passou a ser GERADO pelo bot (ver services/modpack.js)
// e os dois artefatos são zip: o `.mrpack` do Modrinth é um zip com um JSON
// dentro, e o `.zip` dos jars é um zip de verdade. O Node traz `zlib`, que
// comprime bytes, mas nada que monte o container — e a regra do projeto é não
// adicionar dependência por conveniência (ver README).
//
// Escopo limitado de propósito, porque é só o que o mrpack pede: sem zip64
// (nenhum arquivo chega perto de 4 GB, nem de 65535 entradas), sem entradas de
// diretório e sem senha.

// Tabela do CRC-32 (polinômio 0xEDB88320), montada uma vez no import.
//
// O `zlib.crc32` do Node faria isto em C, mas só existe a partir do 20.15 — e o
// package.json promete apenas `>=20`. São 6 linhas para não depender de uma
// versão de patch.
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

/** @param {Buffer} buf @returns {number} CRC-32 sem sinal */
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * Data/hora no formato MS-DOS, que é o que o cabeçalho do zip guarda: dois
 * campos de 16 bits, com segundos em passos de 2 e ano a partir de 1980.
 * @param {Date} date
 */
function dosStamp(date) {
  const ano = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((ano - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Monta um zip em memória.
 *
 * `store: true` (padrão) grava sem comprimir. É o certo para os jars: eles JÁ
 * são zips comprimidos, então deflatá-los de novo gasta CPU para economizar
 * quase nada. Para texto (o `modrinth.index.json`), passe `store: false`.
 *
 * @param {Array<{name: string, data: Buffer, store?: boolean}>} entries
 *   `name` usa barra normal como separador, sempre.
 * @param {Date} [date] carimbo de tempo das entradas
 * @returns {Buffer}
 */
export function zip(entries, date = new Date()) {
  const { time, day } = dosStamp(date);
  const corpo = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nome = Buffer.from(entry.name, 'utf8');
    const dados = entry.data;
    const crc = crc32(dados);
    const store = entry.store ?? true;
    const bytes = store ? dados : deflateRawSync(dados, { level: 9 });
    const metodo = store ? 0 : 8;

    const local = Buffer.alloc(30 + nome.length);
    local.writeUInt32LE(0x04034b50, 0); // assinatura do cabeçalho local
    local.writeUInt16LE(20, 4); // versão mínima para extrair (2.0)
    local.writeUInt16LE(0x0800, 6); // flag: nome do arquivo em UTF-8
    local.writeUInt16LE(metodo, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18); // tamanho comprimido
    local.writeUInt32LE(dados.length, 22); // tamanho original
    local.writeUInt16LE(nome.length, 26);
    local.writeUInt16LE(0, 28); // sem campo extra
    nome.copy(local, 30);

    const dir = Buffer.alloc(46 + nome.length);
    dir.writeUInt32LE(0x02014b50, 0); // assinatura do diretório central
    dir.writeUInt16LE(20, 4); // versão de origem
    dir.writeUInt16LE(20, 6); // versão mínima para extrair
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(metodo, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(day, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(bytes.length, 20);
    dir.writeUInt32LE(dados.length, 24);
    dir.writeUInt16LE(nome.length, 28);
    // extra, comentário, disco e atributos ficam em zero (o Buffer.alloc já zera)
    dir.writeUInt32LE(offset, 42); // onde começa o cabeçalho local desta entrada
    nome.copy(dir, 46);

    corpo.push(local, bytes);
    central.push(dir);
    offset += local.length + bytes.length;
  }

  const diretorio = Buffer.concat(central);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0); // End Of Central Directory
  fim.writeUInt16LE(entries.length, 8); // entradas neste disco
  fim.writeUInt16LE(entries.length, 10); // entradas no total
  fim.writeUInt32LE(diretorio.length, 12);
  fim.writeUInt32LE(offset, 16); // onde começa o diretório central
  return Buffer.concat([...corpo, diretorio, fim]);
}
