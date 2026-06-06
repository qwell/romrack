import { XMLParser } from 'fast-xml-parser';

import { normalizeRegion } from '../../shared/regions.js';
import logger from '../../shared/logger.js';

export type NUSTitleInformation = {
    name: string | null;
    region: string | null;
    productCode: string | null;
    companyCode: string | null;
    version: number | null;
    titleVersion: number | null;
};

const META_XML_PARSER = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
});

export function readMetaXml(buffer: Uint8Array): NUSTitleInformation | null {
    const menu = readMetaXmlJson(buffer);
    const productCode = getMenuString(menu, 'product_code');
    const companyCode = getMenuString(menu, 'company_code');
    const name = getMenuString(menu, 'longname_en');
    const region = normalizeRegion(getMenuString(menu, 'region'), productCode);
    const version = parseMetaUnsignedInt(getMenuString(menu, 'version'));
    const titleVersion = parseMetaUnsignedInt(
        getMenuString(menu, 'title_version')
    );

    if (
        !productCode &&
        !companyCode &&
        !name &&
        !region &&
        version === null &&
        titleVersion === null
    ) {
        return null;
    }

    return { productCode, companyCode, name, region, version, titleVersion };
}

export function readMetaXmlJson(
    buffer: Uint8Array
): Record<string, unknown> | null {
    try {
        const xml = Buffer.from(buffer)
            .toString('utf8')
            .replace(/^\uFEFF/, '');
        const normalized = normalizeXmlText(xml);
        if (!normalized) {
            return null;
        }
        const parsed = META_XML_PARSER.parse(normalized) as {
            menu?: Record<string, unknown>;
        };
        return parsed.menu ?? null;
    } catch (error) {
        logger.warn('metadata', 'failed to parse meta.xml:', String(error));
        return null;
    }
}

export function findXmlStartByte(buffer: Uint8Array): number {
    const source = Buffer.from(buffer);
    const xmlIndex = source.indexOf(Buffer.from('<?xml'));
    if (xmlIndex >= 0) return xmlIndex;
    const menuIndex = source.indexOf(Buffer.from('<menu'));
    return menuIndex >= 0 ? menuIndex : -1;
}

function normalizeXmlText(xml: string): string | null {
    return xml.startsWith('<?xml') || xml.startsWith('<menu') ? xml : null;
}

function getMenuString(
    menu: Record<string, unknown> | null,
    key: string
): string | null {
    const value = menu?.[key];
    if (typeof value !== 'string') return null;
    return value.length > 0 ? value : null;
}

function parseMetaUnsignedInt(value: string | null): number | null {
    if (!value) return null;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
}
