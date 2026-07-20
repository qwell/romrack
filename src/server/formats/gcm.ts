import { inspectDiscFst } from './disc-fst.js';
import { DOL_HEADER_SIZE, parseDolSections } from './dol.js';
import { type RandomAccessReader } from './reader.js';

const GAMECUBE_MAGIC_OFFSET = 0x1c;
const GAMECUBE_MAGIC = 0xc2339f3d;
const DISC_ID_LENGTH = 6;
const DISC_VERSION_OFFSET = 7;
const DISC_NAME_OFFSET = 0x20;
const DISC_NAME_LENGTH = 64;
export const GCM_DISC_HEADER_SIZE = DISC_NAME_OFFSET + DISC_NAME_LENGTH;
export const GAMECUBE_DISC_LAYOUT_HEADER_SIZE = 0x42c;
const DISC_DOL_OFFSET = 0x420;
const DISC_FST_OFFSET = 0x424;
const DISC_FST_SIZE_OFFSET = 0x428;
const DISC_FST_MAX_SIZE = 64 * 1024 * 1024;

export type GcmDiscHeader = {
    gameId: string;
    name: string;
    version: number;
};

export type GameCubeDiscCheck = {
    ok: boolean;
    message: string;
};

export function parseGcmDiscHeader(buffer: Buffer): GcmDiscHeader | null {
    if (
        buffer.length < GCM_DISC_HEADER_SIZE ||
        buffer.readUInt32BE(GAMECUBE_MAGIC_OFFSET) !== GAMECUBE_MAGIC
    ) {
        return null;
    }

    const gameId = buffer.subarray(0, DISC_ID_LENGTH).toString('ascii');
    if (!/^[A-Z0-9]{6}$/.test(gameId)) {
        return null;
    }
    const nameBytes = buffer.subarray(
        DISC_NAME_OFFSET,
        DISC_NAME_OFFSET + DISC_NAME_LENGTH
    );
    const nullIndex = nameBytes.indexOf(0);
    const name = new TextDecoder('shift-jis')
        .decode(nullIndex === -1 ? nameBytes : nameBytes.subarray(0, nullIndex))
        .trim();
    if (!name) {
        return null;
    }

    return {
        gameId,
        name,
        version: buffer[DISC_VERSION_OFFSET] ?? 0,
    };
}

export async function inspectGameCubeDiscStructure(
    reader: RandomAccessReader,
    fileSize: number,
    signal?: AbortSignal
): Promise<{ header: GcmDiscHeader | null; checks: GameCubeDiscCheck[] }> {
    signal?.throwIfAborted();
    const header = await reader.read(0, GAMECUBE_DISC_LAYOUT_HEADER_SIZE);
    const discHeader = parseGcmDiscHeader(header);
    const checks: GameCubeDiscCheck[] = [
        { ok: discHeader !== null, message: 'read GameCube disc identity' },
        {
            ok: header.length === GAMECUBE_DISC_LAYOUT_HEADER_SIZE,
            message: 'read GameCube disc layout header',
        },
    ];
    if (header.length !== GAMECUBE_DISC_LAYOUT_HEADER_SIZE) {
        return { header: discHeader, checks };
    }

    const dolOffset = header.readUInt32BE(DISC_DOL_OFFSET);
    const fstOffset = header.readUInt32BE(DISC_FST_OFFSET);
    const fstSize = header.readUInt32BE(DISC_FST_SIZE_OFFSET);
    const dolOffsetValid =
        dolOffset > 0 && dolOffset + DOL_HEADER_SIZE <= fileSize;
    const fstRangeValid =
        fstOffset > 0 &&
        fstSize > 0 &&
        fstSize <= DISC_FST_MAX_SIZE &&
        fstOffset + fstSize <= fileSize;
    checks.push(
        {
            ok: dolOffsetValid,
            message: 'DOL offset is within the disc image',
        },
        {
            ok: fstRangeValid,
            message: 'FST range is within the disc image',
        }
    );

    if (dolOffsetValid) {
        const dol = await reader.read(dolOffset, DOL_HEADER_SIZE);
        const sections = parseDolSections(dol);
        const invalidSections =
            sections?.filter(
                (section) =>
                    section.offset === 0 ||
                    section.offset + section.size > fileSize
            ).length ?? 0;
        const sectionCount = sections?.length ?? 0;
        checks.push({
            ok: sections !== null && sectionCount > 0 && invalidSections === 0,
            message:
                invalidSections === 0
                    ? `validated ${sectionCount} DOL sections`
                    : `${invalidSections} DOL sections are outside the disc image`,
        });
    }

    if (!fstRangeValid) {
        return { header: discHeader, checks };
    }
    signal?.throwIfAborted();
    const fst = await reader.read(fstOffset, fstSize);
    checks.push({
        ok: fst.length === fstSize,
        message: 'read the complete GameCube FST',
    });
    if (fst.length !== fstSize) {
        return { header: discHeader, checks };
    }

    const fstInspection = inspectDiscFst(fst, fileSize);
    checks.push({
        ok: fstInspection !== null,
        message: 'GameCube FST root and entry table are valid',
    });
    if (!fstInspection) {
        return { header: discHeader, checks };
    }

    const { entryCount, invalidEntries } = fstInspection;
    checks.push({
        ok: invalidEntries === 0,
        message:
            invalidEntries === 0
                ? `validated ${entryCount} GameCube FST entries`
                : `${invalidEntries} GameCube FST entries are invalid`,
    });
    return { header: discHeader, checks };
}
