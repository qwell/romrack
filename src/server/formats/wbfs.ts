export type WbfsHeader = {
    hdSectorSize: number;
    wbfsSectorSize: number;
};

const WBFS_MAGIC = 'WBFS';
const WBFS_HEADER_SIZE = 0x0c;

export function readWbfsHeader(buffer: Buffer): WbfsHeader | null {
    if (
        buffer.length < WBFS_HEADER_SIZE ||
        buffer.toString('ascii', 0, 4) !== WBFS_MAGIC
    ) {
        return null;
    }
    const hdSectorShift = buffer[8];
    const wbfsSectorShift = buffer[9];
    if (
        hdSectorShift < 9 ||
        hdSectorShift > 12 ||
        wbfsSectorShift < hdSectorShift ||
        wbfsSectorShift > 30
    ) {
        return null;
    }
    return {
        hdSectorSize: 2 ** hdSectorShift,
        wbfsSectorSize: 2 ** wbfsSectorShift,
    };
}
