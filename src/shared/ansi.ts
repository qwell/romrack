export type Subsystems =
    | 'server'
    | 'client'
    | 'metadata'
    | '3ds'
    | 'wii'
    | 'wiiu'
    | 'wud'
    | 'download'
    | 'assets';

export const ansi = {
    reset: '\x1b[0m',
    dim: '\x1b[2m',

    black: '\x1b[30m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',

    gray: '\x1b[90m',
    lightRed: '\x1b[91m',
    lightGreen: '\x1b[92m',
    lightYellow: '\x1b[93m',
    lightBlue: '\x1b[94m',
    lightMagenta: '\x1b[95m',
    lightCyan: '\x1b[96m',
    lightWhite: '\x1b[97m',
} as const;

export const {
    reset,
    dim,

    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,

    gray,
    lightRed,
    lightGreen,
    lightYellow,
    lightBlue,
    lightMagenta,
    lightCyan,
    lightWhite,
} = ansi;

export const SubsystemColors: Record<Subsystems, string> = {
    server: green,
    client: cyan,

    metadata: magenta,
    download: yellow,
    assets: lightGreen,

    '3ds': lightYellow,
    wii: lightCyan,
    wiiu: lightBlue,

    wud: lightMagenta,
};
