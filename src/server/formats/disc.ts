import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

export type DiscHeaderLocation = {
    position: number;
    length: number;
};

async function readExact(
    file: FileHandle,
    length: number,
    position: number
): Promise<Buffer | null> {
    const buffer = Buffer.alloc(length);
    const result = await file.read(buffer, 0, length, position);

    return result.bytesRead === length ? buffer : null;
}

export function readDiscHeaderText(
    buffer: Buffer,
    encoding = 'utf-8'
): string | null {
    const nullIndex = buffer.indexOf(0);
    const textBuffer =
        nullIndex === -1 ? buffer : buffer.subarray(0, nullIndex);
    const text = new TextDecoder(encoding).decode(textBuffer).trim();
    return text.length > 0 ? text : null;
}

export async function readIsoDiscHeader(
    filePath: string,
    location: DiscHeaderLocation
): Promise<Buffer | null> {
    const file = await open(filePath, 'r');

    try {
        return await readExact(file, location.length, location.position);
    } finally {
        await file.close();
    }
}
