function getProductCodeRegion(
    productCode: string | null | undefined
): string | null {
    const match = /^WUP-[A-Z0-9]+-[A-Z0-9]{3}([A-Z0-9])$/i.exec(
        productCode ?? ''
    );
    const suffix = match?.[1]?.toUpperCase();

    switch (suffix) {
        case 'A':
            return 'ALL';
        case 'D':
            return 'GER';
        case 'E':
            return 'USA';
        case 'F':
            return 'FRA';
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
        default:
            return null;
    }
}

export function normalizeRegion(
    region: string | null | undefined,
    productCode?: string | null
): string {
    return getProductCodeRegion(productCode) ?? parseRegion(region);
}

export function parseRegion(value: string | null | undefined): string {
    if (!value) {
        return '';
    }

    const normalized = value.toUpperCase();
    if (normalized.length === 3) {
        return normalized;
    }

    const regionMask = Number.parseInt(normalized, 16);
    if (!Number.isFinite(regionMask)) {
        return 'UNK';
    }

    switch (regionMask) {
        case 0x1:
            return 'JPN';
        case 0x2:
            return 'USA';
        case 0x4:
            return 'EUR';
        case 0x7:
            return 'ALL';
        default:
            return 'UNK';
    }
}
