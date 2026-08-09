import { readFileSync } from 'node:fs';

/**
 * Detección de fuentes variables leyendo el directorio de tablas de un WOFF2.
 *
 * Existe por una razón concreta: Chromium NO embebe fuentes con tabla `fvar`.
 * El PDF sale con los FontDescriptor sin /FontFile2 y el visor del reclutador
 * sustituye por la fuente que tenga a mano — otra tipografía, otras métricas y
 * otra paginación que la que vimos nosotros. El build queda en verde y el
 * documento que recibe la empresa no es el que revisamos.
 *
 * El WOFF2 comprime el cuerpo con Brotli, pero su directorio de tablas está en
 * claro justo después del header de 48 bytes, así que alcanza con leer eso.
 */

/** Índices de la tabla conocida del spec WOFF2 que delatan una fuente variable. */
const KNOWN_TABLE_FVAR = 47;
const KNOWN_TABLE_GVAR = 48;
const ARBITRARY_TAG = 0x3f;
const WOFF2_HEADER_BYTES = 48;

export type FontTables = {
  isVariable: boolean;
  tableCount: number;
  /** Tags de las tablas que se pudieron identificar. */
  knownIndices: number[];
};

export function inspectWoff2(buffer: Buffer): FontTables {
  if (buffer.length < WOFF2_HEADER_BYTES || buffer.toString('ascii', 0, 4) !== 'wOF2') {
    throw new Error('El archivo no es un WOFF2 válido (falta la firma wOF2).');
  }

  const numTables = buffer.readUInt16BE(12);
  const knownIndices: number[] = [];
  let offset = WOFF2_HEADER_BYTES;
  let isVariable = false;

  for (let i = 0; i < numTables && offset < buffer.length; i++) {
    const flags = buffer.readUInt8(offset);
    offset += 1;

    const knownIndex = flags & 0x3f;
    if (knownIndex === ARBITRARY_TAG) {
      // Tag arbitrario de 4 bytes a continuación.
      offset += 4;
    } else {
      knownIndices.push(knownIndex);
      if (knownIndex === KNOWN_TABLE_FVAR || knownIndex === KNOWN_TABLE_GVAR) isVariable = true;
    }

    // origLength y, si la tabla vino transformada, transformLength: ambos en
    // UIntBase128, un varint de hasta 5 bytes con el bit alto como continuación.
    offset = skipUIntBase128(buffer, offset);
    const transform = (flags >> 6) & 0x03;
    const isGlyfOrLoca = knownIndex === 10 || knownIndex === 11;
    const transformed = isGlyfOrLoca ? transform === 0 : transform !== 0;
    if (transformed) offset = skipUIntBase128(buffer, offset);
  }

  return { isVariable, tableCount: numTables, knownIndices };
}

function skipUIntBase128(buffer: Buffer, start: number): number {
  let offset = start;
  for (let i = 0; i < 5 && offset < buffer.length; i++) {
    const byte = buffer.readUInt8(offset);
    offset += 1;
    if ((byte & 0x80) === 0) break;
  }
  return offset;
}

export function isVariableFontFile(path: string): boolean {
  return inspectWoff2(readFileSync(path)).isVariable;
}
