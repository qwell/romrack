package main

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

const nodeDistURL = "https://nodejs.org/dist/latest-v24.x"

type platformInfo struct {
	NodePlatform    string
	RuntimePlatform string
	ArchiveExt      string
	NodeRelative    string
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr)
		fmt.Fprintln(os.Stderr, "Error:", err)
		fmt.Fprintln(os.Stderr)

		os.Exit(1)
	}
}

func run() error {
	platform, err := getPlatformInfo()
	if err != nil {
		return err
	}

	exePath, err := os.Executable()
	if err != nil {
		return err
	}

	root := filepath.Dir(exePath)
	app := filepath.Join(root, "app")
	runtimeDir := filepath.Join(root, "runtime")
	platformDir := filepath.Join(runtimeDir, platform.RuntimePlatform)
	nodePath := filepath.Join(platformDir, filepath.FromSlash(platform.NodeRelative))

	if _, err := os.Stat(nodePath); errors.Is(err, os.ErrNotExist) {
		if err := installNodeRuntime(runtimeDir, platformDir, nodePath, platform); err != nil {
			return fmt.Errorf("failed to install Node.js runtime: %w", err)
		}
	}

	serverPath := filepath.Join(app, "server", "index.js")
	args := append([]string{serverPath}, os.Args[1:]...)

	cmd := exec.Command(nodePath, args...)
	cmd.Dir = app
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin

	err = cmd.Run()

	if runtime.GOOS == "windows" {
		fmt.Println()
		fmt.Println("Press Enter to exit...")
		_, _ = fmt.Scanln()
	}

	return err
}

func getPlatformInfo() (platformInfo, error) {
	var arch string

	switch runtime.GOARCH {
	case "amd64":
		arch = "x64"
	case "arm64":
		arch = "arm64"
	default:
		return platformInfo{}, fmt.Errorf("unsupported architecture: %s", runtime.GOARCH)
	}

	switch runtime.GOOS {
	case "windows":
		return platformInfo{
			NodePlatform:    "win-" + arch,
			RuntimePlatform: "win-" + arch,
			ArchiveExt:      "zip",
			NodeRelative:    "node.exe",
		}, nil

	case "darwin":
		return platformInfo{
			NodePlatform:    "darwin-" + arch,
			RuntimePlatform: "macos-" + arch,
			ArchiveExt:      "tar.gz",
			NodeRelative:    "bin/node",
		}, nil

	case "linux":
		return platformInfo{
			NodePlatform:    "linux-" + arch,
			RuntimePlatform: "linux-" + arch,
			ArchiveExt:      "tar.gz",
			NodeRelative:    "bin/node",
		}, nil

	default:
		return platformInfo{}, fmt.Errorf("unsupported operating system: %s", runtime.GOOS)
	}
}

func installNodeRuntime(runtimeDir string, platformDir string, nodePath string, platform platformInfo) error {
	fmt.Println("Installing Node.js runtime for ROM Rack...")
	fmt.Println("This is a one-time setup. Node.js will be downloaded from nodejs.org and verified before use.")
	fmt.Println()

	if err := os.MkdirAll(platformDir, 0755); err != nil {
		return err
	}

	shasumsPath := filepath.Join(runtimeDir, "SHASUMS256.txt")

	fmt.Println("Downloading Node.js release checksums...")
	if err := downloadFile(nodeDistURL+"/SHASUMS256.txt", shasumsPath); err != nil {
		return err
	}

	archiveSuffix := platform.NodePlatform + "." + platform.ArchiveExt

	expectedHash, archiveName, err := findNodeArchive(shasumsPath, archiveSuffix)
	if err != nil {
		return err
	}

	archivePath := filepath.Join(runtimeDir, archiveName)

	if _, err := os.Stat(archivePath); errors.Is(err, os.ErrNotExist) {
		fmt.Println("Downloading Node.js runtime:", archiveName)
		if err := downloadFile(nodeDistURL+"/"+archiveName, archivePath); err != nil {
			return err
		}
	} else {
		fmt.Println("Using cached Node.js runtime:", archiveName)
	}

	fmt.Println("Verifying Node.js download...")
	actualHash, err := sha256File(archivePath)
	if err != nil {
		return err
	}

	expectedHash = strings.ToLower(expectedHash)

	if actualHash != expectedHash {
		_ = os.Remove(archivePath)
		return fmt.Errorf("Node.js download verification failed. Expected: %s Actual: %s", expectedHash, actualHash)
	}

	extractDir := filepath.Join(runtimeDir, "extract-"+platform.RuntimePlatform)
	_ = os.RemoveAll(extractDir)

	fmt.Println("Extracting Node.js runtime...")

	switch platform.ArchiveExt {
	case "zip":
		err = extractNodeFromZip(archivePath, nodePath, platform.NodeRelative)
	case "tar.gz":
		err = extractNodeFromTarGz(archivePath, nodePath, platform.NodeRelative)
	default:
		err = fmt.Errorf("unsupported archive type: %s", platform.ArchiveExt)
	}

	if err != nil {
		return err
	}

	_ = os.RemoveAll(extractDir)

	if runtime.GOOS != "windows" {
		_ = os.Chmod(nodePath, 0755)
	}

	fmt.Println("Node.js runtime installed successfully.")
	fmt.Println()

	return nil
}

func downloadFile(url string, outPath string) error {
	if err := os.MkdirAll(filepath.Dir(outPath), 0755); err != nil {
		return err
	}

	resp, err := http.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("download failed: %s returned %s", url, resp.Status)
	}

	tmpPath := outPath + ".tmp"

	out, err := os.Create(tmpPath)
	if err != nil {
		return err
	}

	_, copyErr := io.Copy(out, resp.Body)
	closeErr := out.Close()

	if copyErr != nil {
		_ = os.Remove(tmpPath)
		return copyErr
	}

	if closeErr != nil {
		_ = os.Remove(tmpPath)
		return closeErr
	}

	return os.Rename(tmpPath, outPath)
}

func findNodeArchive(shasumsPath string, archiveSuffix string) (expectedHash string, archiveName string, err error) {
	file, err := os.Open(shasumsPath)
	if err != nil {
		return "", "", err
	}
	defer file.Close()

	re := regexp.MustCompile(`node-v.*-` + regexp.QuoteMeta(archiveSuffix) + `$`)
	scanner := bufio.NewScanner(file)

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		fields := strings.Fields(line)

		if len(fields) >= 2 && re.MatchString(fields[1]) {
			return fields[0], fields[1], nil
		}
	}

	if err := scanner.Err(); err != nil {
		return "", "", err
	}

	return "", "", fmt.Errorf("could not find Node.js archive ending with %s in SHASUMS256.txt", archiveSuffix)
}

func sha256File(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()

	hash := sha256.New()

	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}

	return hex.EncodeToString(hash.Sum(nil)), nil
}

func extractNodeFromZip(archivePath string, nodePath string, nodeRelative string) error {
	reader, err := zip.OpenReader(archivePath)
	if err != nil {
		return err
	}
	defer reader.Close()

	wantSuffix := "/" + filepath.ToSlash(nodeRelative)

	for _, file := range reader.File {
		name := filepath.ToSlash(file.Name)

		if !strings.HasSuffix(name, wantSuffix) {
			continue
		}

		src, err := file.Open()
		if err != nil {
			return err
		}
		defer src.Close()

		return writeNodeFile(src, nodePath)
	}

	return errors.New("node executable was not found in the archive")
}

func extractNodeFromTarGz(archivePath string, nodePath string, nodeRelative string) error {
	file, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer file.Close()

	gzReader, err := gzip.NewReader(file)
	if err != nil {
		return err
	}
	defer gzReader.Close()

	tarReader := tar.NewReader(gzReader)
	wantSuffix := "/" + filepath.ToSlash(nodeRelative)

	for {
		header, err := tarReader.Next()
		if errors.Is(err, io.EOF) {
			break
		}

		if err != nil {
			return err
		}

		if header.Typeflag != tar.TypeReg {
			continue
		}

		name := filepath.ToSlash(header.Name)

		if !strings.HasSuffix(name, wantSuffix) {
			continue
		}

		return writeNodeFile(tarReader, nodePath)
	}

	return errors.New("node executable was not found in the archive")
}

func writeNodeFile(src io.Reader, nodePath string) error {
	if err := os.MkdirAll(filepath.Dir(nodePath), 0755); err != nil {
		return err
	}

	tmpNodePath := nodePath + ".tmp"

	dst, err := os.Create(tmpNodePath)
	if err != nil {
		return err
	}

	_, copyErr := io.Copy(dst, src)
	closeErr := dst.Close()

	if copyErr != nil {
		_ = os.Remove(tmpNodePath)
		return copyErr
	}

	if closeErr != nil {
		_ = os.Remove(tmpNodePath)
		return closeErr
	}

	if runtime.GOOS != "windows" {
		_ = os.Chmod(tmpNodePath, 0755)
	}

	return os.Rename(tmpNodePath, nodePath)
}
