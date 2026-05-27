export function isWindowsPath(value: string): boolean {
    return /^[A-Z]:[\\/]/i.test(value) || /^\\\\/.test(value);
}
