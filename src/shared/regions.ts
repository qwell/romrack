export const RegionNames = [
    'JPN',
    'USA',
    'EUR',
    'KOR',
    'AUS',
    'CHN',
    'FRA',
    'GER',
    'ITA',
    'RUS',
    'SPA',
    'TWN',
    'WLD',
    'UNK',
] as const;
export type RegionNames = (typeof RegionNames)[number];

export const Region = Object.fromEntries(
    RegionNames.map((region) => [region, region])
) as Record<RegionNames, RegionNames>;

const RegionCountries: Record<RegionNames, string> = {
    AUS: 'Australia',
    CHN: 'China',
    EUR: 'Europe',
    FRA: 'France',
    GER: 'Germany',
    ITA: 'Italy',
    JPN: 'Japan',
    KOR: 'Korea',
    RUS: 'Russia',
    SPA: 'Spain',
    TWN: 'Taiwan',
    USA: 'USA',
    WLD: 'World',
    UNK: 'Unknown',
};

const RegionAliases: Record<string, RegionNames> = {
    /* Wii / Wii U / 3DS */
    'NTSC-J': Region.JPN,
    'NTSC-K': Region.KOR,
    'NTSC-T': Region.TWN,
    'NTSC-U': Region.USA,
    PAL: Region.EUR,
    'PAL-R': Region.RUS,

    /* Switch */
    DEU: Region.GER,
    ESP: Region.SPA,

    ALL: Region.WLD,
};

const RegionMasks: Record<number, RegionNames> = {
    0x01: Region.JPN,
    0x02: Region.USA,
    0x04: Region.EUR,
    0x08: Region.AUS,
    0x10: Region.CHN,
    0x20: Region.KOR,
    0x40: Region.TWN,
    0x7fffffff: Region.WLD,
};

const ProductCodeRegions: Record<string, RegionNames> = {
    A: Region.WLD,
    C: Region.CHN,
    D: Region.GER,
    E: Region.USA,
    F: Region.FRA,
    H: Region.EUR,
    I: Region.ITA,
    J: Region.JPN,
    K: Region.KOR,
    P: Region.EUR,
    R: Region.RUS,
    S: Region.SPA,
    V: Region.ITA,
    W: Region.TWN,
    X: Region.EUR,
    Y: Region.EUR,
    Z: Region.EUR,
};

export function isRegionName(value: string): value is RegionNames {
    return RegionNames.includes(value as RegionNames);
}

export function parseRegion(value: string): RegionNames | '' {
    if (!value) {
        return '';
    }

    const normalized = value.toUpperCase();
    const aliasedRegion = RegionAliases[normalized];
    if (aliasedRegion) {
        return aliasedRegion;
    }

    if (isRegionName(normalized)) {
        return normalized;
    }

    const regionMask = Number.parseInt(normalized, 16);
    if (!Number.isFinite(regionMask)) {
        return Region.UNK;
    }

    return RegionMasks[regionMask] ?? Region.UNK;
}

function getProductCodeRegion(productCode: string): RegionNames | null {
    const code = productCode ?? '';
    const fullCodeMatch =
        /^(?:WUP|CTR|KTR)-[A-Z0-9]+-[A-Z0-9]{3}([A-Z0-9])(?:-\d{2})?$/i.exec(
            code
        );
    const shortCodeMatch = /^[A-Z0-9]{3}([A-Z0-9])$/i.exec(code);
    const suffix = (fullCodeMatch ?? shortCodeMatch)?.[1]?.toUpperCase();

    return suffix ? (ProductCodeRegions[suffix] ?? null) : null;
}

export function getRegionCountry(region: RegionNames): string | null {
    return isRegionName(region) ? RegionCountries[region] : null;
}

export function normalizeRegion(
    region: string | null,
    productCode: string | null
): RegionNames | '' {
    if (region) {
        const parsedRegion = parseRegion(region);
        if (parsedRegion && parsedRegion !== Region.UNK) {
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
