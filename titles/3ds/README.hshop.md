# hShop title export

`hshop.json` is a browser-exported snapshot of hShop search results. It is used as a supplemental 3DS title source.

## Refresh

1. Open [hShop](https://hshop.erista.me) in a browser.
2. Open DevTools and run the export script in the Console.
3. Confirm the final log reports the expected number of collected rows.
4. Save the JSON array output as `titles/3ds/hshop.json`.

## Output Shape

Each exported entry should have this shape:

```json
{
    "hshopId": "8953",
    "name": "Rusty's Real Deal Baseball",
    "titleId": "0004000000126200",
    "version": "0",
    "productCode": "CTR-N-JBCK"
}
```

## Notes

- `CTR-M-*` and `KTR-M-*` product codes are DLC/add-on content product codes. The export strips a trailing `-00` suffix from those values.
- `KTR-*` product codes are New Nintendo 3DS software.
- `TWL-*` product codes are DSi / DSiWare lineage titles. They can be available through the 3DS eShop, but they are not native 3DS titles.
- Themes, ROM hacks, DSiWare, and other unsupported rows are filtered by `scripts/generate-titles.ts`.

## Export Script

```js
(async () => {
    const count = 100;
    const rows = [];

    const getUrl = (offset) => {
        const url = new URL('/search/results', location.origin);
        url.searchParams.set('q', '%');
        url.searchParams.set('qt', 'Text');
        url.searchParams.set('count', count);
        url.searchParams.set('offset', offset);
        url.searchParams.set('sd', 'ascending');
        url.searchParams.set('sb', 'id');
        return url;
    };

    const text = (root, selector) =>
        root.querySelector(selector)?.textContent.trim() || '';

    const getMeta = (entry, label) => {
        for (const item of entry.querySelectorAll('.meta-content')) {
            const spans = item.querySelectorAll('span');
            if (spans[1]?.textContent.trim() === label) {
                return spans[0]?.textContent.trim() || '';
            }
        }
        return '';
    };

    const getTotal = (doc) => {
        const value = [...doc.querySelectorAll('.next-container .nospace')]
            .map((node) => node.textContent.trim())
            .find((text) => text.startsWith('showing '));
        return Number(value?.match(/of\s+(\d+)/)?.[1] || 0);
    };

    const normalizeProductCode = (value) => value.replace(/-00$/, '');

    const parsePage = (html) => {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        return {
            total: getTotal(doc),
            rows: [...doc.querySelectorAll('.elements > a.list-entry')].map(
                (entry) => {
                    const versionText = getMeta(entry, 'Version');
                    return {
                        hshopId: getMeta(entry, 'ID'),
                        titleId: getMeta(entry, 'Title ID'),
                        productCode: normalizeProductCode(
                            getMeta(entry, 'Product Code')
                        ),
                        name: text(entry, '.base-info h3'),
                        version: versionText.match(/\((\d+)\)/)?.[1] || '',
                    };
                }
            ),
        };
    };

    let total = 0;

    for (let offset = 0; total === 0 || offset < total; offset += count) {
        const response = await fetch(getUrl(offset), {
            credentials: 'include',
        });
        const page = parsePage(await response.text());

        if (total === 0) {
            total = page.total;
            console.log(`Total: ${total}`);
        }

        rows.push(...page.rows);
        console.log(`Offset ${offset}: ${page.rows.length}`);

        if (page.rows.length === 0) break;
    }

    console.log(JSON.stringify(rows, null, 2));
    console.log(`Collected: ${rows.length}`);
})();
```
