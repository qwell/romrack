export function parseRegion(value: string): string {
    if (!value) {
        return '';
    }

    const normalized = value.toUpperCase();

    switch (normalized) {
        case 'NTSC-J':
            return 'JPN';
        case 'NTSC-U':
            return 'USA';
        case 'PAL':
            return 'EUR';
    }

    if (normalized.length === 3) {
        return normalized;
    }

    const regionMask = Number.parseInt(normalized, 16);
    if (!Number.isFinite(regionMask)) {
        return 'UNK';
    }

    switch (regionMask) {
        case 0x01:
            return 'JPN';
        case 0x02:
            return 'USA';
        case 0x04:
            return 'EUR';
        case 0x08:
            return 'AUS';
        case 0x10:
            return 'CHN';
        case 0x20:
            return 'KOR';
        case 0x40:
            return 'TWN';
        case 0x7fffffff:
            return 'ALL';
        default:
            return 'UNK';
    }
}

function getProductCodeRegion(productCode: string): string | null {
    const code = productCode ?? '';
    const fullCodeMatch =
        /^(?:WUP|CTR|KTR)-[A-Z0-9]+-[A-Z0-9]{3}([A-Z0-9])(?:-\d{2})?$/i.exec(
            code
        );
    const shortCodeMatch = /^[A-Z0-9]{3}([A-Z0-9])$/i.exec(code);
    const suffix = (fullCodeMatch ?? shortCodeMatch)?.[1]?.toUpperCase();

    switch (suffix) {
        case 'A':
            return 'ALL';
        case 'C':
            return 'CHN';
        case 'D':
            return 'GER';
        case 'E':
            return 'USA';
        case 'F':
            return 'FRA';
        case 'H':
            return 'EUR';
        case 'K':
            return 'KOR';
        case 'I':
            return 'ITA';
        case 'J':
            return 'JPN';
        case 'P':
            return 'EUR';
        case 'R':
            return 'RUS';
        case 'S':
            return 'SPA';
        case 'V':
            return 'ITA';
        case 'W':
            return 'TWN';
        case 'X':
            return 'EUR';
        case 'Y':
            return 'EUR';
        case 'Z':
            return 'EUR';
        default:
            return null;
    }
}

export function normalizeRegion(
    region: string | null,
    productCode: string | null
): string {
    if (region) {
        const parsedRegion = parseRegion(region);
        if (parsedRegion && parsedRegion !== 'UNK') {
            return parsedRegion;
        }
    }

    if (productCode) {
        const productCodeRegion = getProductCodeRegion(productCode);
        if (productCodeRegion) {
            return productCodeRegion;
        }
    }

    return region ? parseRegion(region) : '';
}
