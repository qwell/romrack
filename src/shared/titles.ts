export {
    getVirtualConsolePlatform,
    VirtualConsolePlatform,
} from './virtual-console.js';

const WII_U_TITLE_ID_PATTERN = /^[0-9a-f]{16}$/;
const WII_TITLE_ID_PATTERN = /^[A-Z0-9]{4}$/;

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

const TITLE_PREFIX_BY_KIND: Record<TitleKinds, string> = {
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

export const TITLE_PLATFORMS = ['wii', 'wiiu'] as const;
export const TITLE_MEDIA_TYPES = ['icons', 'covers', 'discs'] as const;
export type TitlePlatform = (typeof TITLE_PLATFORMS)[number];
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
    discUrl?: string | null;
    companyCode: string | null;
    productCode: string | null;
    baseVersions: number[];
    updateVersions: number[];
    dlcVersions: number[];
    availableOnCdn?: boolean;
};

export type TitleDatabaseEntry = {
    titleId: string;
    name: string;
    region: string | null;
    iconUrl: string | null;
    bannerUrl: string | null;
    discUrl: string | null;
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
    discUrl: string | null;
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
    discUrl: string | null;
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

export function replaceTitleKind(titleId: string, kind: TitleKinds): string {
    const prefix = TITLE_PREFIX_BY_KIND[kind];
    const title = identifyWiiUTitle(titleId);

    if (!title || !prefix) {
        throw new Error(`Cannot replace title kind: ${titleId} ${kind}`);
    }

    return `${prefix}${title.family}`;
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
        discUrl: null,
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
    target.discUrl = source.discUrl;
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
    const match = /^WUP-[PN]-([A-Z0-9]{4})$/.exec(code);

    if (match) {
        return match[1];
    }

    return /^[A-Z0-9]{4}$/.test(code) ? code : null;
}

export function normalizeTitleName(name?: string): string {
    // Remove newlines and consecutive spaces.
    return name?.replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim() ?? 'Unknown';
}

export function identifyTitle(titleId: string): TitleIdentity | null {
    return identifyWiiUTitle(titleId) ?? identifyWiiTitle(titleId);
}

export function identifyWiiUTitle(titleId: string): TitleIdentity | null {
    const titleIdNormalized =
        typeof titleId === 'string' ? titleId.toLowerCase() : '';

    if (!WII_U_TITLE_ID_PATTERN.test(titleIdNormalized)) {
        return null;
    }

    const prefix = titleIdNormalized.slice(0, 8);
    const titleFamily = titleIdNormalized.slice(8);
    return {
        titleId: titleIdNormalized,
        platform: 'wiiu',
        kind:
            (Object.entries(TITLE_PREFIX_BY_KIND).find(
                ([, titlePrefix]) => titlePrefix === prefix
            )?.[0] as TitleKinds) ?? TitleKinds.Unknown,
        family: titleFamily,
    };
}

export function identifyWiiTitle(titleId: string): TitleIdentity | null {
    const titleIdNormalized =
        typeof titleId === 'string' ? titleId.toUpperCase() : '';

    if (!WII_TITLE_ID_PATTERN.test(titleIdNormalized)) {
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
    return TITLE_PLATFORMS.includes(value as TitlePlatform);
}

export function isTitleMediaType(value: string): value is TitleMediaType {
    return TITLE_MEDIA_TYPES.includes(value as TitleMediaType);
}
