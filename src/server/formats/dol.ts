export const DOL_HEADER_SIZE = 0x100;

const DOL_TEXT_SECTION_COUNT = 7;
const DOL_DATA_SECTION_COUNT = 11;

export type DolSection = {
    offset: number;
    size: number;
};

export function parseDolSections(header: Buffer): DolSection[] | null {
    if (header.length !== DOL_HEADER_SIZE) {
        return null;
    }

    const sections: DolSection[] = [];
    for (
        let index = 0;
        index < DOL_TEXT_SECTION_COUNT + DOL_DATA_SECTION_COUNT;
        index += 1
    ) {
        const isText = index < DOL_TEXT_SECTION_COUNT;
        const sectionIndex = isText ? index : index - DOL_TEXT_SECTION_COUNT;
        const offset = header.readUInt32BE(
            (isText ? 0x00 : 0x1c) + sectionIndex * 4
        );
        const size = header.readUInt32BE(
            (isText ? 0x90 : 0xac) + sectionIndex * 4
        );
        if (size > 0) {
            sections.push({ offset, size });
        }
    }
    return sections;
}
