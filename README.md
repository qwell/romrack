# WiiU Vault

WiiU Vault is a web-based application that allows users to manage and organize their Wii U game library. It provides features such as game categorization, search and filter functionality, the ability to track title statuses (e.g., complete, incomplete, etc.), download homebrew and other titles, and copy titles to an SD card. The application is built using TypeScript and Node.js, with the aim to be cross-platform.

Work in Progress

## Table of Contents

- [Prerequisites](#prerequisites)
- [Release](#release)
- [Configuration](#configuration)
- [Development](#development)
- [API](#api)
- [Title Data](#title-data)
- [Contributing](#contributing)
- [License](#license)
- [TODO](#todo)

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

- `GET /api/library?includeAll=true`: Scan the configured library. Omit `includeAll` to return only groups with local entries.
- `GET /api/title-icon/:family`: Proxy/cache a title icon from the title database.
- `GET /api/title-metadata?titleId=...`: Fetch base NUS metadata for a title ID.
- `GET /api/title-update?titleId=...`: Check the update title ID and latest update version for a base title.
- `GET /api/title-dlc?titleId=...`: Check the DLC title ID and latest DLC version for a base title.
- `GET /api/title-all?titleId=...`: Fetch base metadata plus update and DLC availability.
- `GET /api/title-download?titleId=...`: Download a base, update, or DLC title into the first readable `wiiuRoots` directory, generate install files, and verify content hashes.

## Title Data

Files in `titles/`:

- `titles.json`: Generated primary title database.
- `extra.json`: Generated supplemental entries from `titledb.csv`.
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
