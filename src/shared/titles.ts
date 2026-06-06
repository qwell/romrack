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

export type ParentKind = (typeof PARENT_KINDS)[number];
export type ChildKind = (typeof CHILD_KINDS)[number];
export type TitleGroupStatus =
    | 'complete'
    | 'incomplete'
    | 'missing'
    | 'unavailable'
    | 'unknown';

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
    titleId: string;
    name: string;
    region: string | null;
    iconUrl: string | null;
    version: number;
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

export type TitleGroup = {
    name: string;
    region: string | null;
    iconUrl: string | null;
    productCode: string | null;
    details: TitleDetails | null;
    availableEntries: AvailableTitleEntry[];

    entries: TitleEntry[];

    family: string;
    titleInDatabase: boolean;
    expectedChildren: ChildKind[];
    status: TitleGroupStatus;
};

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

export function normalizeTitleId(titleId?: string): string {
    const titleIdNormalized = titleId?.toLowerCase() ?? '';
    const titleIdPattern = /^[0-9a-f]{16}$/;

    return titleIdPattern.test(titleIdNormalized) ? titleIdNormalized : '';
}
