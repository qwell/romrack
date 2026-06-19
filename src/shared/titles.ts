export enum TitleKinds {
    Wii = 'Wii',
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

const WII_U_TITLE_ID_PATTERN = /^[0-9a-f]{16}$/;
const WII_TITLE_ID_PATTERN = /^[A-Z0-9]{6}$/;

export const TITLE_PREFIX_BY_KIND: Partial<Record<TitleKinds, string>> = {
    [TitleKinds.vWii]: '00000007',
    [TitleKinds.Base]: '00050000',
    [TitleKinds.Demo]: '00050002',
    [TitleKinds.FCT]: '0005000b',
    [TitleKinds.DLC]: '0005000c',
    [TitleKinds.Update]: '0005000e',
    [TitleKinds.SystemApp]: '00050010',
    [TitleKinds.SystemData]: '0005001b',
    [TitleKinds.SystemApplet]: '00050030',
};

const TITLE_KIND_BY_PREFIX = new Map(
    Object.entries(TITLE_PREFIX_BY_KIND).map(([kind, prefix]) => [
        prefix,
        kind as TitleKinds,
    ])
);

export function replaceTitleKind(titleId: string, kind: TitleKinds): string {
    const prefix = TITLE_PREFIX_BY_KIND[kind];
    const title = identifyWiiUTitle(titleId);

    if (!title || !prefix) {
        throw new Error(`Cannot replace title kind: ${titleId} ${kind}`);
    }

    return `${prefix}${title.family}`;
}

export enum VirtualConsolePlatform {
    NES = 'NES',
    SNES = 'SNES',
    N64 = 'N64',
    GBA = 'GBA',
    NDS = 'NDS',
    Wii = 'Wii',
    PCE = 'PCE',
    MSX = 'MSX',
}

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
export type TitlePlatform = 'wiiu' | 'wii';

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

export function getVirtualConsolePlatform(
    productCode: string | null
): VirtualConsolePlatform | null {
    const code = productCode;

    if (code === null) {
        return null;
    }
    if (code.startsWith('WUP-N-D')) {
        return VirtualConsolePlatform.NDS;
    } else if (code.startsWith('WUP-N-F')) {
        return VirtualConsolePlatform.NES;
    } else if (code.startsWith('WUP-N-J')) {
        return VirtualConsolePlatform.SNES;
    } else if (code.startsWith('WUP-N-N')) {
        return VirtualConsolePlatform.N64;
    } else if (code.startsWith('WUP-N-V')) {
        return VirtualConsolePlatform.Wii;
    } else if (code.startsWith('WUP-N-MN')) {
        return VirtualConsolePlatform.MSX;
    } else if (
        code.startsWith('WUP-N-PA') ||
        code.startsWith('WUP-N-PB') ||
        code.startsWith('WUP-N-PC') ||
        code.startsWith('WUP-N-PD')
    ) {
        return VirtualConsolePlatform.GBA;
    } else if (code.startsWith('WUP-N-PN')) {
        return VirtualConsolePlatform.PCE;
    }

    return null;
}

export function normalizeTitleName(name?: string): string {
    // Remove newlines and consecutive spaces.
    return name?.replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim() ?? 'Unknown';
}

export function identifyTitle(titleId: unknown): TitleIdentity | null {
    return identifyWiiUTitle(titleId) ?? identifyWiiTitle(titleId);
}

export function identifyWiiUTitle(titleId: unknown): TitleIdentity | null {
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
        kind: TITLE_KIND_BY_PREFIX.get(prefix) ?? TitleKinds.Unknown,
        family: titleFamily,
    };
}

export function identifyWiiTitle(titleId: unknown): TitleIdentity | null {
    const titleIdNormalized =
        typeof titleId === 'string' ? titleId.toUpperCase() : '';

    if (!WII_TITLE_ID_PATTERN.test(titleIdNormalized)) {
        return null;
    }

    return {
        titleId: titleIdNormalized,
        platform: 'wii',
        kind: TitleKinds.Wii,
        family: titleIdNormalized,
    };
}
