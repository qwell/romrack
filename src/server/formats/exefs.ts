const EXEFS_HEADER_SIZE = 0x200;
const EXEFS_ENTRY_COUNT = 10;
const EXEFS_ENTRY_SIZE = 0x10;
const EXEFS_ENTRY_NAME_SIZE = 0x08;
const EXEFS_ENTRY_OFFSET_OFFSET = 0x08;
const EXEFS_ENTRY_SIZE_OFFSET = 0x0c;

export type ExeFsFileReadResult =
    | {
          ok: true;
          file: Buffer;
      }
    | {
          ok: false;
          reason: string;
      };

export function readExeFsFile(exefs: Buffer, name: string): Buffer | null {
    const result = inspectExeFsFile(exefs, name);
    return result.ok ? result.file : null;
}

export function inspectExeFsFile(
    exefs: Buffer,
    name: string
): ExeFsFileReadResult {
    if (exefs.length < EXEFS_HEADER_SIZE) {
        return {
            ok: false,
            reason: `ExeFS too small (${exefs.length.toString()} bytes)`,
        };
    }

    const view = dataView(exefs);
    for (let index = 0; index < EXEFS_ENTRY_COUNT; index += 1) {
        const entryOffset = index * EXEFS_ENTRY_SIZE;
        const entryName = readAscii(exefs, entryOffset, EXEFS_ENTRY_NAME_SIZE);

        if (!entryName || entryName !== name) {
            continue;
        }

        const fileOffset =
            EXEFS_HEADER_SIZE +
            view.getUint32(entryOffset + EXEFS_ENTRY_OFFSET_OFFSET, true);
        const fileSize = view.getUint32(
            entryOffset + EXEFS_ENTRY_SIZE_OFFSET,
            true
        );

        if (fileOffset + fileSize > exefs.length) {
            return {
                ok: false,
                reason: `ExeFS ${name} entry out of bounds (offset=${fileOffset.toString()}, size=${fileSize.toString()}, exefs=${exefs.length.toString()})`,
            };
        }

        return {
            ok: true,
            file: exefs.slice(fileOffset, fileOffset + fileSize),
        };
    }

    return {
        ok: false,
        reason: `ExeFS file not found: ${name}`,
    };
}

function readAscii(buffer: Buffer, offset: number, length: number): string {
    return Buffer.from(buffer)
        .subarray(offset, offset + length)
        .toString('ascii')
        .replace(/\0.*$/, '')
        .trim();
}

function dataView(buffer: Buffer): DataView {
    return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
