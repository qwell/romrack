const DISC_FST_ENTRY_SIZE = 0x0c;
const DISC_FST_ROOT_ENTRY_COUNT_OFFSET = 0x08;

export type DiscFstInspection = {
    entryCount: number;
    invalidEntries: number;
};

export function inspectDiscFst(
    fst: Buffer,
    imageSize: number
): DiscFstInspection | null {
    if (fst.length < DISC_FST_ENTRY_SIZE || fst[0] !== 1) {
        return null;
    }

    const entryCount = fst.readUInt32BE(DISC_FST_ROOT_ENTRY_COUNT_OFFSET);
    const namesOffset = entryCount * DISC_FST_ENTRY_SIZE;
    if (
        entryCount === 0 ||
        !Number.isSafeInteger(namesOffset) ||
        namesOffset > fst.length
    ) {
        return null;
    }

    let invalidEntries = 0;
    for (let index = 1; index < entryCount; index += 1) {
        const offset = index * DISC_FST_ENTRY_SIZE;
        const isDirectory = fst[offset] === 1;
        const nameOffset = fst.readUInt32BE(offset) & 0x00ff_ffff;
        const valueOffset = fst.readUInt32BE(offset + 4);
        const valueLength = fst.readUInt32BE(offset + 8);
        const nameStart = namesOffset + nameOffset;
        const hasName =
            nameStart < fst.length && fst.indexOf(0, nameStart) !== -1;
        const validRange = isDirectory
            ? valueOffset < index &&
              valueLength > index &&
              valueLength <= entryCount
            : valueOffset + valueLength <= imageSize;
        if (!hasName || !validRange) {
            invalidEntries += 1;
        }
    }

    return { entryCount, invalidEntries };
}
