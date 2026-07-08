# [ROM Rack](https://romrack.com/)

ROM Rack is a web-based application that allows users to manage and organize their Wii U game library. It provides features such as game categorization, search and filter functionality, the ability to track title statuses (e.g., complete, incomplete, etc.), download homebrew and other titles, and copy titles to an SD card. The application is built using TypeScript and Node.js, with the aim to be cross-platform.

Work in Progress

## Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Release](#release)
- [Configuration](#configuration)
- [Development](#development)
- [API](#api)
- [Title Data](#title-data)
- [Contributing](#contributing)
- [License](#license)
- [TODO](#todo)
- [Acknowledgements](#acknowledgements)

## Features

- Browse library - view your games grouped by title.
- Search & filters - find games by name, region, or download status.
- Download titles - select versions and start downloads.
- Manage downloads - see progress, retry, or clear failed items.
- Manage local copies - list stored titles and delete unwanted ones.
- Copy to SD card - select titles and copy to an inserted FAT32 SD.
- Title verification - view broken files and delete or re-download them.
- Detail sidebar - quick access to synopsis, version, size, and status.

## Prerequisites

For packaged releases, no system Node.js or Yarn installation is required. The packaged launch scripts download and verify a Node.js runtime on first run.

Development from source requires [Node 24](https://nodejs.org/) and [Yarn](https://yarnpkg.com/).

## Configuration

`config.json` lives at `~/.romrack/config.json`. If it does not exist, ROM Rack creates it with default values on startup.

Available options:

```json
{
    "host": "127.0.0.1",
    "port": 3000,
    "openBrowser": true,
    "wiiRoots": [],
    "wiiuRoots": []
}
```

`host` sets the network host ROM Rack binds to.

`port` sets the port ROM Rack listens on.

`openBrowser` controls whether ROM Rack opens your browser on startup using the configured host and port.

`wiiRoots` is a list of Wii library directories.

`wiiuRoots` is a list of Wii U title directories.

For title metadata generation or title downloads, put `common.key` in `~/.romrack/common.key`. If no key is found, ROM Rack will try to download one and save it there. The key may be raw 16-byte binary, hex text, or comma-separated byte literals.

## Release

From a packaged release:

1. Download the latest release zip from GitHub.
2. Extract the release zip.
3. Edit `~/.romrack/config.json` if needed.
4. Run `start.bat` on Windows or `./start.sh` on macOS/Linux.

By default, the server listens on the host and port configured in `config.json`, then opens the app in your browser when `openBrowser` is `true`.

## Development

Clone the repository.

```bash
git clone https://github.com/qwell/romrack.git
```

Navigate to the repo directory.

```bash
cd romrack
```

Install dependencies using Yarn.

```bash
yarn install
```

Build and run from source.

```bash
yarn build
yarn start
```

## Available Scripts

- `lint`: Run ESLint to check for code quality issues.

```bash
yarn lint
```

- `format`: Run Prettier to format the code.

```bash
yarn format
```

- `clean`: Clean up generated artifacts.

```bash
yarn clean
```

- `build`: Compile TypeScript files and output in the `dist/` directory.

```bash
yarn build
```

- `start`: Execute the server.

```bash
yarn start
```

- `test`: Execute tests with Vitest.

```bash
yarn test
```

- `release`: Build a versioned release zip in `release/`.

```bash
yarn release
```

- `generate:titles`: Regenerate title data.

```bash
yarn generate:titles
```

`yarn generate:titles` only needs to be run when refreshing the checked-in title databases, updating title source files, rebuilding GameTDB data, or supplementing icons, and is only necessary in very specific cases. By default it reads cached NUS scan results from `titles/3ds/nus.json` and `titles/wiiu/nus.json`; pass `--refresh-nus` to refresh those files. If a NUS cache file is missing, the generator scans automatically. The ROM Rack server must already be running when a NUS scan is needed because the generator calls the local metadata endpoints.

## API

- `GET /api/library`: Scan the configured library.
- `GET /api/library/verify`: Fully verify library file integrity and report progress.
- `GET /api/library/convert?titleId=...`: Queue WUD/WUX conversion for a title.
- `GET /api/title-icon/:family`: Proxy/cache a title icon from the title database.
- `GET /api/title?titleId=...`: Fetch base NUS metadata plus update and DLC availability.
- `GET /api/storage/list-fat32`: List FAT32 storage destinations. On WSL, unmounted Windows-only drives are returned for display but must be mounted in WSL before use.
- `GET /api/storage/copy?titleId=...&dest=...`: Queue a local title copy to a FAT32 destination.
- `GET /api/storage/move?titleId=...&dest=...`: Queue a local title move to a FAT32 destination and remove the local source after a successful copy.
- `GET /api/storage/delete?titleId=...`: Queue deletion of all local copies for a title ID.

## WebSocket API

The browser connects to `/api/socket`. On connection the server sends an `app.connected` event with the current state (downloads, storage copies, storage deletes, and optional library verification status).

Server events:

- `app.connected`: Initial app state payload (downloads, storageCopies, storageDeletes, libraryVerifyStatus, libraryConversions).
- `download.queueChanged`: Current download queue updates.
- `storage.copyChanged`: Current storage copy/move queue updates.
- `storage.delete.changed`: Current storage delete queue updates.
- `library.verifyStatus`: Full library verification progress and status updates.
- `library.convertChanged`: Current WUD/WUX conversion queue.
- `title.validate.changed`: Size-only title validation progress and results.

Client commands:

- `download.queue`: Queue title downloads (payload: items).
- `download.retry`: Retry a failed download (payload: id).
- `download.clear`: Clear a download entry (payload: id).
- `download.cancel`: Cancel an active download (payload: id).
- `storage.copy.retry`: Retry a storage copy/move (payload: id).
- `storage.copy.clear`: Clear a storage copy/move entry (payload: id).
- `storage.copy.cancel`: Cancel an active storage copy/move (payload: id).
- `storage.delete.retry`: Retry a storage delete operation (payload: id).
- `storage.delete.clear`: Clear a storage delete entry (payload: id).
- `storage.delete.cancel`: Cancel a storage delete operation (payload: id).
- `library.verify.cancel`: Cancel an in-progress full library verification.
- `library.verify.clear`: Clear current verification status.
- `library.verify.download`: Queue downloads for verification failures.
- `library.convert.cancel`: Cancel the active WUD/WUX conversion.
- `library.convert.clear`: Clear a WUD/WUX conversion queue entry.
- `library.convert.retry`: Retry a failed WUD/WUX conversion.
- `title.validate.queue`: Queue size-only validation for a title (payload: `{ titleId, name }`).

## Title Data

Files in `titles/`:

- `titles.json`: Generated primary title database.
- `icons.json`: Generated title icon URLs.
- `exclude.json`: Title IDs skipped by generation.

- `wiiu/nus.json`: Cached Wii U NUS scan results.
- `3ds/nus.json`: Cached 3DS NUS scan results.

- `wii/tdb.xml`: Source Wii TDB XML from [GameTDB](https://www.gametdb.com/wiitdb.zip), used for Wii supplemental title data and UI details.
- `wiiu/tdb.xml`: Source Wii U TDB XML from [GameTDB](https://www.gametdb.com/wiiutdb.zip), used by the UI for title details.
- `3ds/tdb.xml`: Source 3DS TDB XML from [GameTDB](https://www.gametdb.com/3dstdb.zip), used by the UI for title details.

- `wiiu/wiiubrew.csv`: Exported Wii U CSV for supplemental title data from [WiiUBrew](https://wiiubrew.org/wiki/Title_database).

- `3ds/hshop.json`: Browser-exported 3DS supplemental hShop title data. See `titles/3ds/README.hshop.md` for details.

## Contributing

If you'd like to contribute, pull requests and issues are always appreciated.

## License

ROM Rack is licensed under the [GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.en.html) or later.

## TODO

- Show when newer versions of base titles, updates, or DLC are available.

## Acknowledgements

Thanks to [GameTDB](https://gametdb.com/) for the supplemental title databases, icons, and banner images.

Thanks to [hShop](https://hshop.erista.me/) for the supplemental 3DS title database.
