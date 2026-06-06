import { normalizeTitleName } from './titles.js';

export function isNonEmptyString(value: string): boolean {
    return value.length > 0;
}

export function readNullTerminatedString(
    buffer: Buffer,
    offset: number,
    encoding: BufferEncoding = 'utf8'
): string {
    let end = offset;
    while (end < buffer.length && buffer[end] !== 0) {
        end += 1;
    }
    return buffer.toString(encoding, offset, end);
}

export function safeDirectoryName(value: string): string {
    const invalid = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);
    const normalized = normalizeTitleName(value);
    return (
        [...normalized]
            .filter((char) => !invalid.has(char) && char.charCodeAt(0) >= 32)
            .join('')
            .replace(/\s+/g, ' ')
            .trim() || 'Unknown'
    );
}
