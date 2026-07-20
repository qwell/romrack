import { Region, RegionNames } from '../../shared/regions.js';

export type Tmd = {
    header: TmdHeader;
    contents: TmdContent[];
    certificates: TmdCertificates;
};

export type TmdHeader = {
    titleId: Buffer;
    titleVersion: number;
    region: string;
    systemType: TmdSystemType;
    contentCount: number;
};

export type TmdContent = {
    id: number;
    index: number;
    type: number;
    size: number;
    hash: Buffer;
};

export type TmdCertificates = {
    certificate1: TmdCertificateFull | null;
    certificate2: TmdCertificateFull | null;
};

export type TmdCertificateFull = {
    raw: Buffer;
    parsed: TmdCertificate | null;
};

export type TmdCertificate = {
    signatureType: CertificateSignatureType;
    signature: Buffer;
    issuer: string;
    keyType: CertificateKeyType;
    name: string;
    keyId: number;
    publicKey: Buffer;
};

type CertificateSignatureType =
    | typeof CERT_SIGNATURE_RSA_4096
    | typeof CERT_SIGNATURE_RSA_2048
    | typeof CERT_SIGNATURE_ECC;

type CertificateKeyType =
    | typeof CERT_KEY_RSA_4096
    | typeof CERT_KEY_RSA_2048
    | typeof CERT_KEY_ECC;

export type TmdSystemType = '3ds' | 'wii' | 'wiiu' | typeof SYSTEM_TYPE_UNKNOWN;

export const TMD_TITLE_FILE = 'title.tmd';

const SYSTEM_TYPE_UNKNOWN = 'unknown';

const CERT_SIGNATURE_RSA_4096 = 0x00010000;
const CERT_SIGNATURE_RSA_2048 = 0x00010001;
const CERT_SIGNATURE_ECC = 0x00010002;

const CERT_KEY_RSA_4096 = 0x00000000;
const CERT_KEY_RSA_2048 = 0x00000001;
const CERT_KEY_ECC = 0x00000002;

const TMD_TITLE_ID_OFFSET = 0x18c;
const TMD_TITLE_ID_SIZE = 8;
const TMD_VERSION_OFFSET = 0x1dc;
const TMD_VERSION_SIZE = 2;
const TMD_REGION_OFFSET = 0x19c;
const TMD_REGION_SIZE = 2;
const TMD_CONTENT_COUNT_OFFSET = 0x1de;
const TMD_CONTENT_COUNT_SIZE = 2;
const TMD_CONTENT_OFFSET = 0xb04;
const TMD_CONTENT_SIZE = 0x30;
const WII_TMD_CONTENT_OFFSET = 0x1e4;
const WII_TMD_CONTENT_SIZE = 0x24;
const WII_TMD_CONTENT_HASH_SIZE = 0x14;
const TMD_CERTIFICATE_1_SIZE = 0x400;
const TMD_CERTIFICATE_2_SIZE = 0x300;
const TMD_CONTENT_HASH_SIZE = 0x20;
const TMD_CONTENT_HASH_OFFSET = 0x10;

const CERT_SIGNATURE_TYPE_OFFSET = 0x00;
const CERT_SIGNATURE_OFFSET = 0x04;
const CERT_ISSUER_BASE_OFFSET = 0x40;
const CERT_KEY_TYPE_BASE_OFFSET = 0x80;
const CERT_NAME_BASE_OFFSET = 0x84;
const CERT_KEY_ID_BASE_OFFSET = 0x0c4;
const CERT_PUBLIC_KEY_BASE_OFFSET = 0x0c8;
const CERT_TEXT_SIZE = 64;

const CERT_SIGNATURE_RSA_4096_SIZE = 0x200;
const CERT_SIGNATURE_RSA_2048_SIZE = 0x100;
const CERT_SIGNATURE_ECC_SIZE = 0x3c;

const CERT_KEY_RSA_4096_SIZE = 0x238;
const CERT_KEY_RSA_2048_SIZE = 0x138;
const CERT_KEY_ECC_SIZE = 0x78;

export function readTmdFromBuffer(buffer: Buffer): Tmd | null {
    const header = readTmdHeader(buffer.subarray(0, TMD_CONTENT_OFFSET));
    if (!header) {
        return null;
    }
    const contentOffset =
        header.systemType === 'wii'
            ? WII_TMD_CONTENT_OFFSET
            : TMD_CONTENT_OFFSET;
    const contentSize =
        header.systemType === 'wii' ? WII_TMD_CONTENT_SIZE : TMD_CONTENT_SIZE;
    const hashSize =
        header.systemType === 'wii'
            ? WII_TMD_CONTENT_HASH_SIZE
            : TMD_CONTENT_HASH_SIZE;
    const contentTableSize = header.contentCount * contentSize;
    if (buffer.length < contentOffset + contentTableSize) {
        return null;
    }
    const contents = readTmdContents(
        buffer.subarray(contentOffset),
        header.contentCount,
        contentSize,
        hashSize
    );
    const certificateOffset = contentOffset + contentTableSize;
    const certificates = readTmdCertificates(
        buffer.subarray(certificateOffset)
    );
    return { header, contents, certificates };
}

export function readTmdHeader(buffer: Buffer): TmdHeader | null {
    if (buffer.length < TMD_CONTENT_COUNT_OFFSET + TMD_CONTENT_COUNT_SIZE) {
        return null;
    }
    const titleId = Buffer.from(
        buffer.subarray(
            TMD_TITLE_ID_OFFSET,
            TMD_TITLE_ID_OFFSET + TMD_TITLE_ID_SIZE
        )
    );
    return {
        titleId,
        titleVersion: buffer.readUintBE(TMD_VERSION_OFFSET, TMD_VERSION_SIZE),
        region: getRegionName(
            buffer.readUintBE(TMD_REGION_OFFSET, TMD_REGION_SIZE)
        ),
        systemType: getSystemType(titleId),
        contentCount: buffer.readUIntBE(
            TMD_CONTENT_COUNT_OFFSET,
            TMD_CONTENT_COUNT_SIZE
        ),
    };
}

export function readTmdCertificate(buffer: Buffer): TmdCertificate | null {
    if (buffer.length < CERT_SIGNATURE_OFFSET) {
        return null;
    }
    const signatureType = buffer.readUInt32BE(CERT_SIGNATURE_TYPE_OFFSET);
    if (!isValidCertificateSignatureType(signatureType)) {
        return null;
    }
    const signatureSize = getCertificateSignatureSize(signatureType);
    const issuerOffset = CERT_ISSUER_BASE_OFFSET + signatureSize;
    const keyTypeOffset = CERT_KEY_TYPE_BASE_OFFSET + signatureSize;
    const nameOffset = CERT_NAME_BASE_OFFSET + signatureSize;
    const keyIdOffset = CERT_KEY_ID_BASE_OFFSET + signatureSize;
    const publicKeyOffset = CERT_PUBLIC_KEY_BASE_OFFSET + signatureSize;

    if (buffer.length < publicKeyOffset) {
        return null;
    }
    const keyType = buffer.readUInt32BE(keyTypeOffset);
    if (!isCertificateKeyType(keyType)) {
        return null;
    }
    const publicKeySize = getCertificatePublicKeySize(keyType);
    if (buffer.length < publicKeyOffset + publicKeySize) {
        return null;
    }
    return {
        signatureType,
        signature: Buffer.from(
            buffer.subarray(
                CERT_SIGNATURE_OFFSET,
                CERT_SIGNATURE_OFFSET + signatureSize
            )
        ),
        issuer: buffer
            .toString('ascii', issuerOffset, issuerOffset + CERT_TEXT_SIZE)
            .replace(/\0.*$/, ''),
        keyType,
        name: buffer
            .toString('ascii', nameOffset, nameOffset + CERT_TEXT_SIZE)
            .replace(/\0.*$/, ''),
        keyId: buffer.readUInt32BE(keyIdOffset),
        publicKey: Buffer.from(
            buffer.subarray(publicKeyOffset, publicKeyOffset + publicKeySize)
        ),
    };
}

export function getTitleIdHex(value: Buffer): string {
    return Buffer.from(value).toString('hex');
}

export function getTitleIdNumber(value: Buffer): bigint {
    return Buffer.from(value).readBigUInt64BE(0);
}

function readTmdContents(
    buffer: Buffer,
    contentCount: number,
    contentSize: number,
    hashSize: number
): TmdContent[] {
    const contents: TmdContent[] = [];
    for (let i = 0; i < contentCount; i += 1) {
        const offset = i * contentSize;
        contents.push(
            readTmdContent(
                buffer.subarray(offset, offset + contentSize),
                hashSize
            )
        );
    }
    return contents;
}

function readTmdContent(buffer: Buffer, hashSize: number): TmdContent {
    return {
        id: buffer.readUInt32BE(0),
        index: buffer.readUInt16BE(4),
        type: buffer.readUInt16BE(6),
        size: Number(buffer.readBigUInt64BE(8)),
        hash: Buffer.from(
            buffer.subarray(
                TMD_CONTENT_HASH_OFFSET,
                TMD_CONTENT_HASH_OFFSET + hashSize
            )
        ),
    };
}

function readTmdCertificates(buffer: Buffer): TmdCertificates {
    if (buffer.length < TMD_CERTIFICATE_1_SIZE + TMD_CERTIFICATE_2_SIZE) {
        return { certificate1: null, certificate2: null };
    }
    const cert1Raw = Buffer.from(buffer.subarray(0, TMD_CERTIFICATE_1_SIZE));
    const cert2Raw = Buffer.from(
        buffer.subarray(
            TMD_CERTIFICATE_1_SIZE,
            TMD_CERTIFICATE_1_SIZE + TMD_CERTIFICATE_2_SIZE
        )
    );
    return {
        certificate1: {
            raw: cert1Raw,
            parsed: readTmdCertificate(Buffer.from(cert1Raw)),
        },
        certificate2: {
            raw: cert2Raw,
            parsed: readTmdCertificate(Buffer.from(cert2Raw)),
        },
    };
}

function getCertificatePublicKeySize(keyType: CertificateKeyType): number {
    switch (keyType) {
        case CERT_KEY_RSA_4096:
            return CERT_KEY_RSA_4096_SIZE;
        case CERT_KEY_RSA_2048:
            return CERT_KEY_RSA_2048_SIZE;
        case CERT_KEY_ECC:
            return CERT_KEY_ECC_SIZE;
    }
}

function getCertificateSignatureSize(
    signatureType: CertificateSignatureType
): number {
    switch (signatureType) {
        case CERT_SIGNATURE_RSA_4096:
            return CERT_SIGNATURE_RSA_4096_SIZE;
        case CERT_SIGNATURE_RSA_2048:
            return CERT_SIGNATURE_RSA_2048_SIZE;
        case CERT_SIGNATURE_ECC:
            return CERT_SIGNATURE_ECC_SIZE;
    }
}

function isValidCertificateSignatureType(
    value: number
): value is CertificateSignatureType {
    return (
        value === CERT_SIGNATURE_RSA_4096 ||
        value === CERT_SIGNATURE_RSA_2048 ||
        value === CERT_SIGNATURE_ECC
    );
}

function isCertificateKeyType(value: number): value is CertificateKeyType {
    return (
        value === CERT_KEY_RSA_4096 ||
        value === CERT_KEY_RSA_2048 ||
        value === CERT_KEY_ECC
    );
}

function getRegionName(region: number): string {
    return RegionNames[region] ?? Region.UNK;
}

function getSystemType(titleId: Buffer): TmdSystemType {
    if (!titleId || titleId.length < 2) {
        return SYSTEM_TYPE_UNKNOWN;
    }
    if (titleId[0] === 0x00 && titleId[1] === 0x05) {
        return 'wiiu';
    }
    if (titleId[0] === 0x00 && titleId[1] === 0x04) {
        return '3ds';
    }
    if (titleId[0] === 0x00 && titleId[1] === 0x01) {
        return 'wii';
    }
    return SYSTEM_TYPE_UNKNOWN;
}
