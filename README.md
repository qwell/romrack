# WiiU Vault

WiiU Vault is a web-based application that allows users to manage and organize their Wii U game library. It provides features such as game categorization, search and filter functionality, the ability to track title statuses (e.g., complete, incomplete, etc.), download homebrew and other titles, and copy titles to an SD card. The application is built using TypeScript and Node.js, with the aim to be cross-platform.

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

`config.json` lives at `~/.wiiu-vault/config.json`. If it does not exist, WiiU Vault creates it with default values on startup. Set `wiiuRoots` to one or more Wii U title directories.

For title metadata generation or title downloads, put `common.key` in `~/.wiiu-vault/common.key`. If no key is found, WiiU Vault will try to download one and save it there. The key may be raw 16-byte binary, hex text, or comma-separated byte literals.

## Release

From a packaged release:

1. Download the latest release zip from GitHub.
2. Extract the release zip.
3. Edit `~/.wiiu-vault/config.json` if needed.
4. Run `start.bat` on Windows or `./start.sh` on macOS/Linux.

By default, the server listens on the host and port configured in `config.json`, then opens the app in your browser when `openBrowser` is `true`.

## Development

Clone the repository.

```bash
git clone https://github.com/qwell/wiiu-vault.git
```

Navigate to the repo directory.

```bash
cd wiiu-vault
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

`yarn generate:titles` only needs to be run when refreshing the checked-in title databases, updating `titles/titledb.csv`, rebuilding WiiUTDB data, or supplementing icons, and is only necessary in very specific cases. The WiiU Vault server must already be running because the generator calls the local metadata endpoints.

## API

- `GET /api/library`: Scan the configured library.
- `GET /api/library/validate`: Validate library file integrity and report progress.
- `GET /api/title-icon/:family`: Proxy/cache a title icon from the title database.
- `GET /api/title?titleId=...`: Fetch base NUS metadata plus update and DLC availability.
- `GET /api/storage/list-fat32`: List FAT32 storage destinations. On WSL, unmounted Windows-only drives are returned for display but must be mounted in WSL before use.
- `GET /api/storage/copy?titleId=...&dest=...`: Queue a local title copy to a FAT32 destination.
- `GET /api/storage/move?titleId=...&dest=...`: Queue a local title move to a FAT32 destination and remove the local source after a successful copy.
- `GET /api/delete?titleId=...`: Queue deletion of all local copies for a title ID.

## WebSocket API

The browser connects to `/api/socket`. On connection the server sends an `app.connected` event with the current state (downloads, storage copies, deletes, and optional library validation status).

Server events:

- `app.connected`: Initial app state payload (downloads, storageCopies, deletes, libraryValidateStatus).
- `download.queueChanged`: Current download queue updates.
- `storage.copyChanged`: Current storage copy/move queue updates.
- `delete.changed`: Current delete queue updates.
- `library.validateStatus`: Library validation progress and status updates.
- `title.verify.changed`: Title verification progress and results.

Client commands:

- `download.queue`: Queue title downloads (payload: items).
- `download.retry`: Retry a failed download (payload: id).
- `download.clear`: Clear a download entry (payload: id).
- `download.cancel`: Cancel an active download (payload: id).
- `storage.copy.retry`: Retry a storage copy/move (payload: id).
- `storage.copy.clear`: Clear a storage copy/move entry (payload: id).
- `storage.copy.cancel`: Cancel an active storage copy/move (payload: id).
- `delete.retry`: Retry a delete operation (payload: id).
- `delete.clear`: Clear a delete entry (payload: id).
- `library.validate.cancel`: Cancel an in-progress library validation.
- `library.validate.clear`: Clear current validation status.
- `library.validate.failure.clear`: Clear recorded validation failures.
- `library.validate.failure.download`: Queue downloads for validation failures.
- `title.verify.queue`: Queue verification for a title (payload: `{ titleId, name }`).

## Title Data

Files in `titles/`:

- `titles.json`: Generated primary title database.
- `icons.json`: Generated title icon URLs.
- `exclude.json`: Title IDs skipped by generation.
- `titledb.csv`: Source CSV for supplemental title data from [WiiUBrew](https://wiiubrew.org/wiki/Title_database).
- `wiiutdb.xml`: Source WiiUTDB XML from [GameTDB](https://gametdb.com).
- `wiiutdb.json`: Generated WiiUTDB details used by the UI.

## Contributing

If you'd like to contribute, pull requests and issues are always appreciated.

## License

WiiU Vault is licensed under the [GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.en.html) or later.

## TODO

- Show when newer versions of base titles, updates, or DLC are available.
- Download titles from the UI.
