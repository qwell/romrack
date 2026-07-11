import { ansi, SubsystemColors, Subsystems } from './ansi.js';

export const longestSubsystem = Math.max(
    ...Subsystems.map((subsystem) => subsystem.length)
);

export function padSubsystem(subsystem: Subsystems): string {
    return subsystem.padEnd(longestSubsystem);
}

function prefix(subsystem: Subsystems): string {
    return `${SubsystemColors[subsystem]}[${padSubsystem(subsystem)}]${ansi.reset}`;
}

function message(color: string | string[], args: string[]): string {
    const colorPrefix = Array.isArray(color) ? color.join('') : color;

    return `${colorPrefix}${args.join(' ')}${ansi.reset}`;
}

export function debug(subsystem: Subsystems, ...args: string[]): void {
    if (process.env.DEBUG !== '1') {
        return;
    }

    console.debug(
        `${prefix(subsystem)} ${message([ansi.gray, ansi.dim], args)}`
    );
}

export function info(subsystem: Subsystems, ...args: string[]): void {
    console.info(`${prefix(subsystem)} ${message(ansi.blue, args)}`);
}

export function log(subsystem: Subsystems, ...args: string[]): void {
    console.log(`${prefix(subsystem)} ${message([], args)}`);
}

export function warn(subsystem: Subsystems, ...args: string[]): void {
    console.warn(`${prefix(subsystem)} ${message(ansi.yellow, args)}`);
}

export function error(subsystem: Subsystems, ...args: string[]): void {
    console.error(`${prefix(subsystem)} ${message(ansi.red, args)}`);
}

const logger = {
    debug,
    info,
    log,
    warn,
    error,
};
export default logger;
