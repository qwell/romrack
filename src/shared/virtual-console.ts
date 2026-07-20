import { type TitlePlatform } from './titles.js';

export const VirtualConsolePlatform = {
    Arcade: 'Arcade',
    C64: 'C64',
    NES: 'NES',
    SNES: 'SNES',
    N64: 'N64',
    GBA: 'GBA',
    NDS: 'NDS',
    NeoGeo: 'Neo Geo',
    SMS: 'SMS',
    SMD: 'SMD',
    TurboGrafx: 'TurboGrafx',
    TurboGrafxCD: 'TurboGrafx CD',
    Wii: 'Wii',
    MSX: 'MSX',
} as const;

export type VirtualConsolePlatform =
    (typeof VirtualConsolePlatform)[keyof typeof VirtualConsolePlatform];

function getWiiVirtualConsolePlatforms(): Array<
    readonly [prefix: string, platform: VirtualConsolePlatform]
> {
    return [
        ['EA', VirtualConsolePlatform.NeoGeo],

        ['C', VirtualConsolePlatform.C64],
        ['E', VirtualConsolePlatform.Arcade],
        ['F', VirtualConsolePlatform.NES],
        ['J', VirtualConsolePlatform.SNES],
        ['L', VirtualConsolePlatform.SMS],
        ['M', VirtualConsolePlatform.SMD],
        ['N', VirtualConsolePlatform.N64],
        ['P', VirtualConsolePlatform.TurboGrafx],
        ['Q', VirtualConsolePlatform.TurboGrafxCD],
        ['X', VirtualConsolePlatform.MSX],
    ];
}

function getWiiUVirtualConsolePlatforms(): Array<
    readonly [prefix: string, platform: VirtualConsolePlatform]
> {
    return [
        ['MN', VirtualConsolePlatform.MSX],
        ['PA', VirtualConsolePlatform.GBA],
        ['PB', VirtualConsolePlatform.GBA],
        ['PC', VirtualConsolePlatform.GBA],
        ['PD', VirtualConsolePlatform.GBA],
        ['PN', VirtualConsolePlatform.TurboGrafx],

        ['D', VirtualConsolePlatform.NDS],
        ['F', VirtualConsolePlatform.NES],
        ['J', VirtualConsolePlatform.SNES],
        ['N', VirtualConsolePlatform.N64],
        ['V', VirtualConsolePlatform.Wii],
    ];
}

function getPlatformByPrefix(
    productCode: string | null,
    platforms: Array<
        readonly [prefix: string, platform: VirtualConsolePlatform]
    >
): VirtualConsolePlatform | null {
    const code = productCode?.trim().toUpperCase() ?? '';

    return platforms.find(([prefix]) => code.startsWith(prefix))?.[1] ?? null;
}

export function getWiiVirtualConsolePlatform(
    productCode: string | null
): VirtualConsolePlatform | null {
    return getPlatformByPrefix(productCode, getWiiVirtualConsolePlatforms());
}

export function getWiiUVirtualConsolePlatform(
    productCode: string | null
): VirtualConsolePlatform | null {
    return getPlatformByPrefix(productCode, getWiiUVirtualConsolePlatforms());
}

export function getVirtualConsolePlatform(
    platform: TitlePlatform,
    productCode: string | null
): VirtualConsolePlatform | null {
    switch (platform) {
        case '3ds':
        case 'gamecube':
            return null;
        case 'wii':
            return getWiiVirtualConsolePlatform(productCode);
        case 'wiiu':
            return getWiiUVirtualConsolePlatform(productCode);
    }
}
