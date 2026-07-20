export type RandomAccessReader = {
    read(position: number, length: number): Promise<Buffer>;
    close(): Promise<void>;
};
