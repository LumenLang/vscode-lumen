const vscode = require("vscode");
const lsp = require("vscode-languageclient/node");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const { execFile } = require("child_process");
const os = require("os");

/** @type {lsp.LanguageClient | undefined} */
let client;

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
    const output = vscode.window.createOutputChannel("Lumen LSP");

    context.subscriptions.push(vscode.commands.registerCommand('lumen.showTestScript', () => {
        vscode.window.showInformationMessage('Show Test luma script clicked!');
    }));

    const jarPath = path.join(context.extensionPath, "server", "LumenLSP.jar");
    if (!fs.existsSync(jarPath)) {
        vscode.window.showErrorMessage(
            "Lumen LSP: server JAR not found. The extension may be installed incorrectly."
        );
        return;
    }

    let javaPath;
    try {
        javaPath = await resolveJava(context, output);
    } catch (err) {
        vscode.window.showErrorMessage(
            "Lumen LSP: failed to find or download a Java runtime. " + err.message
        );
        return;
    }

    const serverOptions = {
        command: javaPath,
        args: ["-jar", jarPath],
        options: { stdio: "pipe" }
    };

    const clientOptions = {
        documentSelector: [{ scheme: "file", language: "lumen" }],
        outputChannel: output,
        traceOutputChannel: output
    };

    client = new lsp.LanguageClient("lumen", "Lumen LSP", serverOptions, clientOptions);
    await client.start();
}

async function deactivate() {
    if (client) {
        await client.stop();
    }
}

/**
 * Resolves a working java binary.
 * Checks the system PATH first, then a previously cached download,
 * then downloads a fresh JRE from Adoptium.
 *
 * @param {vscode.ExtensionContext} context
 * @param {vscode.OutputChannel} output
 * @returns {Promise<string>} absolute path to a java binary
 */
async function resolveJava(context, output) {
    const systemJava = await findSystemJava(output);
    if (systemJava) {
        output.appendLine("Using system Java: " + systemJava);
        return systemJava;
    }
    output.appendLine("No system Java found, checking cache...");

    const jreDir = path.join(context.globalStorageUri.fsPath, "jre");
    const cachedJava = findJavaInDir(jreDir);
    if (cachedJava) {
        output.appendLine("Using cached JRE: " + cachedJava);
        return cachedJava;
    }
    output.appendLine("No cached JRE found, downloading...");

    return downloadJre(jreDir, output);
}

/**
 * Walks process.env.PATH and returns the absolute path to the first java binary
 * that successfully executes, or null if none found.
 *
 * @param {vscode.OutputChannel} output
 * @returns {Promise<string|null>}
 */
async function findSystemJava(output) {
    const bin = process.platform === "win32" ? "java.exe" : "java";
    const dirs = (process.env.PATH || "").split(path.delimiter);

    for (const dir of dirs) {
        const candidate = path.join(dir.trim(), bin);
        if (!fs.existsSync(candidate)) continue;

        output.appendLine("Found java candidate: " + candidate);
        const works = await new Promise((resolve) => {
            execFile(candidate, ["-version"], { timeout: 5000 }, (err) => {
                resolve(!err);
            });
        });

        if (works) return candidate;
        output.appendLine("Candidate failed (exit non-zero), skipping: " + candidate);
    }

    return null;
}

/**
 * Searches for a java binary inside the given directory.
 *
 * @param {string} dir
 * @returns {string|null}
 */
function findJavaInDir(dir) {
    if (!fs.existsSync(dir)) return null;

    const bin = process.platform === "win32" ? "java.exe" : "java";

    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
        const candidate = path.join(dir, entry, "bin", bin);
        if (fs.existsSync(candidate)) return candidate;
    }

    const direct = path.join(dir, "bin", bin);
    if (fs.existsSync(direct)) return direct;

    return null;
}

/**
 * Returns the Adoptium platform and architecture identifiers for the current system.
 *
 * @returns {{ arch: string, os: string }}
 */
function getPlatformInfo() {
    const archMap = { x64: "x64", arm64: "aarch64", arm: "arm" };
    const osMap = { linux: "linux", darwin: "mac", win32: "windows" };

    const arch = archMap[os.arch()];
    const platform = osMap[process.platform];

    if (!arch || !platform) {
        throw new Error("Unsupported platform: " + process.platform + " " + os.arch());
    }

    return { arch: arch, os: platform };
}

/**
 * Downloads and extracts a JRE 21 from Adoptium into the given directory.
 *
 * @param {string} jreDir
 * @param {vscode.OutputChannel} output
 * @returns {Promise<string>} path to the java binary
 */
async function downloadJre(jreDir, output) {
    const { arch, os: platformOs } = getPlatformInfo();
    const ext = platformOs === "windows" ? "zip" : "tar.gz";

    const url = "https://api.adoptium.net/v3/binary/latest/21/ga/" + platformOs + "/" + arch + "/jre/hotspot/normal/eclipse?project=jdk";

    fs.mkdirSync(jreDir, { recursive: true });
    const archivePath = path.join(jreDir, "jre." + ext);

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: "Lumen LSP: Downloading Java runtime...",
            cancellable: false
        },
        async (progress) => {
            progress.report({ message: "Downloading..." });
            await downloadFile(url, archivePath, output);

            progress.report({ message: "Extracting..." });
            await extractArchive(archivePath, jreDir, ext, output);

            fs.unlinkSync(archivePath);
        }
    );

    const java = findJavaInDir(jreDir);
    if (!java) {
        throw new Error("JRE downloaded but java binary not found after extraction.");
    }

    if (process.platform !== "win32") {
        fs.chmodSync(java, 0o755);
    }

    output.appendLine("Downloaded JRE: " + java);
    return java;
}

/**
 * Downloads a file to disk, following redirects.
 *
 * @param {string} url
 * @param {string} dest
 * @param {vscode.OutputChannel} output
 * @returns {Promise<void>}
 */
function downloadFile(url, dest, output) {
    return new Promise((resolve, reject) => {
        output.appendLine("Downloading: " + url);

        const protocol = url.startsWith("https") ? https : http;
        const request = protocol.get(url, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                output.appendLine("HTTP " + response.statusCode + " -> " + response.headers.location);
                response.destroy();
                downloadFile(response.headers.location, dest, output)
                    .then(resolve, reject);
                return;
            }

            if (response.statusCode !== 200) {
                response.destroy();
                return reject(new Error("HTTP " + response.statusCode));
            }

            output.appendLine("File response 200 OK, writing to: " + dest);
            const file = fs.createWriteStream(dest);
            const timeout = setTimeout(() => {
                file.destroy();
                if (fs.existsSync(dest)) {
                    fs.unlinkSync(dest);
                }
                reject(new Error("Download timeout after 5 min"));
            }, 300000);

            response.pipe(file);
            file.on("finish", () => {
                clearTimeout(timeout);
                file.close(() => {
                    output.appendLine("Download complete: " + dest);
                    resolve();
                });
            });
            file.on("error", (err) => {
                clearTimeout(timeout);
                if (fs.existsSync(dest)) {
                    fs.unlinkSync(dest);
                }
                reject(err);
            });
        });

        request.on("error", (err) => {
            reject(new Error("Request error: " + err.message));
        });

        request.end();
    });
}

/**
 * Extracts a tar.gz or zip archive into the destination directory.
 *
 * @param {string} archivePath
 * @param {string} destDir
 * @param {string} ext "tar.gz" or "zip"
 * @param {vscode.OutputChannel} output
 * @returns {Promise<void>}
 */
function extractArchive(archivePath, destDir, ext, output) {
    return new Promise((resolve, reject) => {
        output.appendLine("Extracting: " + archivePath);
        if (ext === "tar.gz") {
            execFile("tar", ["xzf", archivePath, "-C", destDir], (err, _stdout, stderr) => {
                if (err) {
                    return reject(new Error("Extract failed: " + stderr));
                }
                output.appendLine("Extraction complete");
                resolve();
            });
        } else {
            const cmd = process.platform === "win32"
                ? "powershell"
                : "unzip";
            const args = process.platform === "win32"
                ? ["-Command", "Expand-Archive -Path '" + archivePath
                    + "' -DestinationPath '" + destDir + "' -Force"]
                : [archivePath, "-d", destDir];

            execFile(cmd, args, (err, _stdout, stderr) => {
                if (err) {
                    return reject(new Error("Extract failed (" + cmd + "): " + stderr));
                }
                output.appendLine("Extraction complete");
                resolve();
            });
        }
    });
}

module.exports = { activate, deactivate };