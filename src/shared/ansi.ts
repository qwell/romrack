export type Subsystems =
    | 'server'
    | 'client'
    | 'metadata'
    | 'wiiu'
    | 'wud'
    | 'download';

export const ansi = {
    reset: '\x1b[0m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m',
} as const;

export const { reset, dim, red, green, yellow, blue, magenta, cyan, gray } =
    ansi;

export const SubsystemColors: Record<Subsystems, string> = {
    server: green,
    client: cyan,
    metadata: magenta,
    wiiu: blue,
    wud: magenta,
    download: yellow,
};
