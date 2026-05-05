import { format } from 'util';

type Subsystems = 'server' | 'metadata' | 'wiiu';

const reset = '\x1b[0m';
const dim = '\x1b[2m';
const red = '\x1b[31m';
const green = '\x1b[32m';
const yellow = '\x1b[33m';
const blue = '\x1b[34m';
const magenta = '\x1b[35m';
const gray = '\x1b[90m';

const subsystemColors: Record<Subsystems, string> = {
    server: green,
    metadata: magenta,
    wiiu: blue,
};

function prefix(subsystem: Subsystems): string {
    return `${subsystemColors[subsystem]}[${subsystem}]${reset}`;
}

function message(color: string | string[], args: unknown[]): string {
    const colorPrefix = Array.isArray(color) ? color.join('') : color;

    return `${colorPrefix}${format(...args)}${reset}`;
}

export function log(subsystem: Subsystems, ...args: unknown[]): void {
    console.log(`${prefix(subsystem)} ${message([], args)}`);
}

export function info(subsystem: Subsystems, ...args: unknown[]): void {
    console.info(`${prefix(subsystem)} ${message(blue, args)}`);
}

export function warn(subsystem: Subsystems, ...args: unknown[]): void {
    console.warn(`${prefix(subsystem)} ${message(yellow, args)}`);
}

export function error(subsystem: Subsystems, ...args: unknown[]): void {
    console.error(`${prefix(subsystem)} ${message(red, args)}`);
}

export function debug(subsystem: Subsystems, ...args: unknown[]): void {
    if (process.env.DEBUG !== '1') {
        return;
    }

    console.debug(`${prefix(subsystem)} ${message([gray, dim], args)}`);
}

const logger = {
    log,
    info,
    warn,
    error,
    debug,
};
export default logger;
