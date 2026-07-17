export {
    getVirtualConsolePlatform,
    VirtualConsolePlatform,
} from './virtual-console.js';

const TITLE_ID_PATTERN = /^[a-f0-9]{16}$/;
const PRODUCT_CODE_PATTERN = /^[A-Z0-9]{4}$/;
const WII_PRODUCT_CODE_PATTERN = /^([A-Z0-9]{4})[A-Z0-9]{2}$/;
const WII_U_PRODUCT_CODE_PATTERN = /^WUP-[PN]-([A-Z0-9]{4})$/;
const THREE_DS_PRODUCT_CODE_PATTERN = /^(?:CTR|KTR)-[A-Z0-9]-([A-Z0-9]{4})$/;

export enum TitleKinds {
    vWii = 'vWii',
    Base = 'Base',
    Demo = 'Demo',
    FCT = 'FCT',
    SystemApp = 'System App',
    SystemData = 'System Data',
    SystemApplet = 'System Applet',
    DLC = 'DLC',
    Update = 'Update',
    Unknown = 'Unknown',
}

const WII_U_TITLE_PREFIX_BY_KIND: Record<TitleKinds, string> = {
    [TitleKinds.vWii]: '00000007',
    [TitleKinds.Base]: '00050000',
    [TitleKinds.Demo]: '00050002',
    [TitleKinds.FCT]: '0005000b',
    [TitleKinds.DLC]: '0005000c',
    [TitleKinds.Update]: '0005000e',
    [TitleKinds.SystemApp]: '00050010',
    [TitleKinds.SystemData]: '0005001b',
    [TitleKinds.SystemApplet]: '00050030',
    [TitleKinds.Unknown]: '00000000',
};

const THREE_DS_TITLE_PREFIX_BY_KIND: Record<TitleKinds, string | null> = {
    [TitleKinds.vWii]: null,
    [TitleKinds.Base]: '00040000',
    [TitleKinds.Demo]: '00040002',
    [TitleKinds.FCT]: null,
    [TitleKinds.SystemApp]: null,
    [TitleKinds.SystemData]: null,
    [TitleKinds.SystemApplet]: null,
    [TitleKinds.Update]: '0004000e',
    [TitleKinds.DLC]: '0004008c',
    [TitleKinds.Unknown]: '00000000',
};

export const PARENT_KINDS = [
    TitleKinds.vWii,
    TitleKinds.Base,
    TitleKinds.Demo,
    TitleKinds.FCT,
    TitleKinds.SystemApp,
    TitleKinds.SystemData,
    TitleKinds.SystemApplet,
] as const;

export const CHILD_KINDS = [TitleKinds.DLC, TitleKinds.Update] as const;
export const DOWNLOADABLE_KINDS = [
    TitleKinds.Base,
    TitleKinds.Update,
    TitleKinds.DLC,
] as const;

export type ParentKind = (typeof PARENT_KINDS)[number];
export type ChildKind = (typeof CHILD_KINDS)[number];

export type TitleGroupStatus =
    | 'complete'
    | 'incomplete'
    | 'missing'
    | 'unavailable'
    | 'unknown';

export const TitlePlatform = {
    '3ds': '3DS',
    wii: 'Wii',
    wiiu: 'Wii U',
} as const;
export type TitlePlatform = keyof typeof TitlePlatform;

export const TITLE_PLATFORM_IDS = Object.keys(TitlePlatform) as TitlePlatform[];

export const TITLE_MEDIA_TYPES = ['icons', 'covers'] as const;
export type TitleMediaType = (typeof TITLE_MEDIA_TYPES)[number];

export type TitleIdentity = {
    titleId: string;
    platform: TitlePlatform;
    kind: TitleKinds;
    family: string;
};

export type RawTitleDatabaseEntry = {
    titleId: string;
    name: string;
    region: string | null;
    iconUrl: string | null;
    bannerUrl?: string | null;
    companyCode: string | null;
    productCode: string | null;
    baseVersions: number[];
    updateVersions: number[];
    dlcVersions: number[];
    availableOnCdn?: boolean;
};

export type TitleDatabaseEntry = {
    platform: TitlePlatform;
    titleId: string;
    name: string;
    region: string | null;
    iconUrl: string | null;
    bannerUrl: string | null;
    companyCode: string | null;
    productCode: string | null;
    baseVersions: number[];
    updateVersions: number[];
    dlcVersions: number[];
    availableOnCdn?: boolean;

    family: string;
};

export type TitleEntry = {
    platform: TitlePlatform;
    titleId: string;
    name: string;
    region: string | null;
    iconUrl: string | null;
    bannerUrl: string | null;
    version: number | null;
    kind: TitleKinds;

    sizeBytes: number;
    copyCount: number;
};

export type TitleInputControl = {
    type: string;
    required: boolean;
};

export type TitleDetails = {
    tvFormat: string | null;
    languages: string[];
    synopsis: string | null;
    developer: string | null;
    genre: string[];
    inputPlayers: number | null;
    inputControls: TitleInputControl[];
    sizeBytes: number | null;
};

export type AvailableTitleEntry = {
    kind: TitleKinds;
    titleId: string;
    versions: number[];
    availableOnCdn: boolean;
};

export type WudTitleEntry = {
    titles: Array<{
        titleId: string;
        version: number;
    }>;
    imageName: string;
    sizeBytes: number;
    copyCount: number;
};

export type TitleGroup = {
    platform: TitlePlatform;
    name: string;
    region: string | null;
    iconUrl: string | null;
    bannerUrl: string | null;
    productCode: string | null;
    details: TitleDetails | null;
    availableEntries: AvailableTitleEntry[];
    wudEntries: WudTitleEntry[];

    entries: TitleEntry[];

    family: string;
    titleInDatabase: boolean;
    expectedChildren: ChildKind[];
    status: TitleGroupStatus;
};

function getTitlePrefix(platform: TitlePlatform, kind: TitleKinds): string {
    let prefix;

    switch (platform) {
        case '3ds':
            prefix = THREE_DS_TITLE_PREFIX_BY_KIND[kind];
            break;
        case 'wiiu':
            prefix = WII_U_TITLE_PREFIX_BY_KIND[kind];
            break;
        case 'wii':
            break;
    }

    if (!prefix) {
        throw new Error(`Cannot get title prefix: ${platform} ${kind}`);
    }

    return prefix;
}

export function getTitleId(
    platform: TitlePlatform,
    familyOrTitleId: string,
    kind: TitleKinds
): string {
    const family = getTitleFamily(familyOrTitleId);
    let titleId: string;

    switch (platform) {
        case 'wii': {
            titleId = family.toUpperCase();
            if (!PRODUCT_CODE_PATTERN.test(titleId)) {
                throw new Error(`Cannot format Wii title ID: ${family}`);
            }
            break;
        }
        case '3ds':
        case 'wiiu': {
            const prefix = getTitlePrefix(platform, kind);

            titleId = `${prefix}${family}`.toLowerCase();
            if (!TITLE_ID_PATTERN.test(titleId)) {
                throw new Error(
                    `Cannot format ${platform} title ID: ${family} ${kind}`
                );
            }
            break;
        }
    }

    return titleId;
}

export function getTitleFamily(familyOrTitleId: string): string {
    return identifyTitle(familyOrTitleId)?.family ?? familyOrTitleId;
}

export function replaceTitleKind(titleId: string, kind: TitleKinds): string {
    const title = identifyTitle(titleId);

    if (title?.platform === 'wii') {
        return title.titleId;
    }

    if (!title) {
        throw new Error(`Cannot replace title kind: ${titleId} ${kind}`);
    }

    return getTitleId(title.platform, title.family, kind);
}

export function createTitleGroup(
    platform: TitlePlatform,
    family: string
): TitleGroup {
    return {
        platform,
        family,
        name: 'Unknown',
        region: null,
        productCode: null,
        iconUrl: null,
        bannerUrl: null,
        details: null,
        availableEntries: [],
        wudEntries: [],
        titleInDatabase: false,
        expectedChildren: [],
        status: 'unknown',

        entries: [],
    };
}

export function cloneTitleGroup(group: TitleGroup): TitleGroup {
    return {
        ...group,
        availableEntries: [...group.availableEntries],
        wudEntries: [...group.wudEntries],
        expectedChildren: [...group.expectedChildren],
        entries: [...group.entries],
    };
}

function updateEntryWithNewerVersion(
    target: TitleEntry,
    source: TitleEntry
): void {
    if (source.version === null) {
        return;
    }

    if (target.version !== null && source.version <= target.version) {
        return;
    }

    target.version = source.version;
    target.name = source.name;
    target.region = source.region;
    target.iconUrl = source.iconUrl;
    target.bannerUrl = source.bannerUrl;
    target.sizeBytes = source.sizeBytes;
}

export function mergeTitleEntry(
    entries: TitleEntry[],
    entry: TitleEntry
): void {
    const existing = entries.find(
        (candidate) => candidate.titleId === entry.titleId
    );

    if (!existing) {
        entries.push({ ...entry });
        return;
    }

    existing.copyCount += entry.copyCount;
    updateEntryWithNewerVersion(existing, entry);
}

export function getWiiUProductCode(
    value: string | null | undefined
): string | null {
    const code = value?.trim().toUpperCase() ?? '';
    const match = WII_U_PRODUCT_CODE_PATTERN.exec(code);

    if (match) {
        return match[1];
    }

    return PRODUCT_CODE_PATTERN.test(code) ? code : null;
}

export function getWiiProductCode(
    value: string | null | undefined
): string | null {
    const code = value?.trim().toUpperCase() ?? '';
    const match = WII_PRODUCT_CODE_PATTERN.exec(code);

    if (match) {
        return match[1];
    }

    return PRODUCT_CODE_PATTERN.test(code) ? code : null;
}

export function getThreeDSProductCode(value: string | null): string | null {
    const code = value?.trim().toUpperCase() ?? '';
    const match = THREE_DS_PRODUCT_CODE_PATTERN.exec(code);

    if (match) {
        return match[1];
    }

    return PRODUCT_CODE_PATTERN.test(code) ? code : null;
}

export function normalizeTitleName(name: string): string {
    // Remove newlines and consecutive spaces.
    return name.replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim() ?? 'Unknown';
}

export function identifyTitle(
    titleId: string,
    platform?: TitlePlatform
): TitleIdentity | null {
    switch (platform) {
        case '3ds':
            return identifyThreeDSTitle(titleId);
        case 'wii':
            return identifyWiiTitle(titleId);
        case 'wiiu':
            return identifyWiiUTitle(titleId);
        default:
            return (
                identifyWiiUTitle(titleId) ??
                identifyThreeDSTitle(titleId) ??
                identifyWiiTitle(titleId)
            );
    }
}

export function identifyWiiUTitle(titleId: string): TitleIdentity | null {
    const titleIdNormalized =
        typeof titleId === 'string' ? titleId.toLowerCase() : '';

    if (!TITLE_ID_PATTERN.test(titleIdNormalized)) {
        return null;
    }

    const prefix = titleIdNormalized.slice(0, 8);
    const kind =
        (Object.entries(WII_U_TITLE_PREFIX_BY_KIND).find(
            ([, titlePrefix]) => titlePrefix === prefix
        )?.[0] as TitleKinds | undefined) ?? null;

    if (!kind) {
        return null;
    }

    const titleFamily = titleIdNormalized.slice(8);
    return {
        titleId: titleIdNormalized,
        platform: 'wiiu',
        kind,
        family: titleFamily,
    };
}

export function identifyThreeDSTitle(titleId: string): TitleIdentity | null {
    const titleIdNormalized =
        typeof titleId === 'string' ? titleId.toLowerCase() : '';

    if (!TITLE_ID_PATTERN.test(titleIdNormalized)) {
        return null;
    }

    const prefix = titleIdNormalized.slice(0, 8);
    const kind =
        (Object.entries(THREE_DS_TITLE_PREFIX_BY_KIND).find(
            ([, titlePrefix]) => titlePrefix === prefix
        )?.[0] as TitleKinds | undefined) ?? null;

    if (!kind) {
        return null;
    }

    return {
        titleId: titleIdNormalized,
        platform: '3ds',
        kind,
        family: titleIdNormalized.slice(8),
    };
}

export function identifyWiiTitle(titleId: string): TitleIdentity | null {
    const titleIdNormalized =
        typeof titleId === 'string' ? titleId.toUpperCase() : '';

    if (!PRODUCT_CODE_PATTERN.test(titleIdNormalized)) {
        return null;
    }

    return {
        titleId: titleIdNormalized,
        platform: 'wii',
        kind: TitleKinds.Base,
        family: titleIdNormalized,
    };
}

export function isTitlePlatform(value: string): value is TitlePlatform {
    return Object.hasOwn(TitlePlatform, value);
}

export function isTitleMediaType(value: string): value is TitleMediaType {
    return TITLE_MEDIA_TYPES.includes(value as TitleMediaType);
}
