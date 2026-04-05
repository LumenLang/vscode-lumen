const vscode = require("vscode");
const lsp = require("vscode-languageclient/node");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const { execFile, spawn } = require("child_process");
const os = require("os");

/** @type {lsp.LanguageClient | undefined} */
let client;

let headlessProcess = null;
let headlessReady = false;
let headlessBuffer = "";
let headlessResponseCb = null;
let diagnosticCollection;
let validationTimer = null;
let lastValidatedSource = null;
let lastTypeTime = 0;
let textChangeDisposable = null;
let resolvedJavaPath = null;
let extensionContext = null;
let outputChannel = null;
let requestQueue = Promise.resolve();
let validationInFlight = false;
let statusBarItem = null;

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
    extensionContext = context;
    outputChannel = vscode.window.createOutputChannel("Lumen LSP");
    context.subscriptions.push(outputChannel);
    const output = outputChannel;

    diagnosticCollection = vscode.languages.createDiagnosticCollection("lumen-headless");
    context.subscriptions.push(diagnosticCollection);

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    context.subscriptions.push(statusBarItem);

    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((doc) => {
        diagnosticCollection.delete(doc.uri);
    }));

    context.subscriptions.push(vscode.commands.registerCommand("lumen.validateScript", async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== "lumen") {
            vscode.window.showWarningMessage("No active Lumen script to validate.");
            return;
        }

        stopValidationLoop();
        lastTypeTime = Date.now();

        try {
            const hasErrors = await validateDocument(editor.document);
            if (hasErrors) {
                startValidationLoop();
            } else {
                vscode.window.showInformationMessage("Lumen validation passed!");
            }
        } catch (err) {
            vscode.window.showErrorMessage("Validation failed: " + err.message);
        }
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
    stopValidationLoop();
    if (headlessProcess) {
        headlessProcess.kill();
        headlessProcess = null;
        headlessReady = false;
    }
    if (diagnosticCollection) {
        diagnosticCollection.dispose();
    }
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

async function ensureHeadless() {
    if (headlessProcess && headlessReady) return;

    if (headlessProcess) {
        headlessProcess.kill();
        headlessProcess = null;
        headlessReady = false;
    }

    const jarPath = path.join(extensionContext.extensionPath, "server", "LumenHeadless.jar");
    if (!fs.existsSync(jarPath)) {
        throw new Error("LumenHeadless.jar not found");
    }

    if (!resolvedJavaPath) {
        resolvedJavaPath = await resolveJava(extensionContext, outputChannel);
    }

    requestQueue = Promise.resolve();

    return new Promise((resolve, reject) => {
        let settled = false;
        let readyTimeout;

        function settle(fn) {
            if (settled) return;
            settled = true;
            clearTimeout(readyTimeout);
            fn();
        }

        headlessProcess = spawn(resolvedJavaPath, ["-jar", jarPath, "--server"], {
            stdio: ["pipe", "pipe", "pipe"]
        });

        headlessBuffer = "";

        headlessProcess.on("error", (err) => {
            outputChannel.appendLine("LumenHeadless spawn error: " + err.message);
            headlessProcess = null;
            headlessReady = false;
            settle(() => reject(new Error("Failed to spawn LumenHeadless: " + err.message)));
        });

        headlessProcess.stdout.on("data", (data) => {
            headlessBuffer += data.toString();
            let idx;
            while ((idx = headlessBuffer.indexOf("\n")) !== -1) {
                const line = headlessBuffer.substring(0, idx).trim();
                headlessBuffer = headlessBuffer.substring(idx + 1);
                if (!line) continue;

                try {
                    const parsed = JSON.parse(line);
                    if (!settled && parsed.status === "ready") {
                        headlessReady = true;
                        outputChannel.appendLine("LumenHeadless ready: " + JSON.stringify(parsed));
                        settle(() => resolve());
                    } else if (headlessResponseCb) {
                        const cb = headlessResponseCb;
                        headlessResponseCb = null;
                        cb(parsed);
                    }
                } catch (e) {
                    outputChannel.appendLine("LumenHeadless stdout (unparseable): " + line);
                }
            }
        });

        headlessProcess.stderr.on("data", (data) => {
            outputChannel.appendLine("LumenHeadless stderr: " + data.toString().trim());
        });

        headlessProcess.on("close", (code) => {
            outputChannel.appendLine("LumenHeadless exited with code " + code);
            headlessProcess = null;
            headlessReady = false;
            settle(() => reject(new Error("LumenHeadless exited before ready (code " + code + ")")));
            if (headlessResponseCb) {
                const cb = headlessResponseCb;
                headlessResponseCb = null;
                cb({
                    ok: false,
                    error: "Process exited unexpectedly",
                    errors: [{ line: 1, message: "LumenHeadless process exited unexpectedly" }]
                });
            }
        });

        readyTimeout = setTimeout(() => {
            settle(() => {
                if (headlessProcess) {
                    headlessProcess.kill();
                    headlessProcess = null;
                    headlessReady = false;
                }
                reject(new Error("LumenHeadless did not become ready within 30s"));
            });
        }, 30000);
    });
}

function sendHeadlessRequest(request) {
    const queued = requestQueue.then(() => {
        return new Promise((resolve, reject) => {
            if (!headlessProcess || !headlessReady) {
                return reject(new Error("LumenHeadless is not running"));
            }

            const timeout = setTimeout(() => {
                headlessResponseCb = null;
                if (headlessProcess) {
                    headlessProcess.kill();
                    headlessProcess = null;
                    headlessReady = false;
                }
                reject(new Error("LumenHeadless request timed out after 30s"));
            }, 30000);

            headlessResponseCb = (response) => {
                clearTimeout(timeout);
                resolve(response);
            };

            headlessProcess.stdin.write(JSON.stringify(request) + "\n", (err) => {
                if (err) {
                    clearTimeout(timeout);
                    headlessResponseCb = null;
                    reject(new Error("Failed to write to LumenHeadless: " + err.message));
                }
            });
        });
    });
    requestQueue = queued.catch(() => {});
    return queued;
}

async function validateDocument(document) {
    statusBarItem.text = "$(sync~spin) Lumen: Validating...";
    statusBarItem.show();

    const source = document.getText();
    const name = path.basename(document.fileName);

    try {
        await ensureHeadless();

        const response = await sendHeadlessRequest({
            op: "compile",
            source: source,
            name: name
        });

        lastValidatedSource = source;

        if (response.ok) {
            diagnosticCollection.set(document.uri, []);
            outputChannel.appendLine("Validation OK: " + name);
            return false;
        }

        const errors = response.errors || [];
        const isCompilePhase = response.phase === "compile";
        const diagnostics = errors.map((err) => {
            const line = Math.max(0, (err.line || 1) - 1);
            const range = new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER);
            const msg = isCompilePhase ? "[Java compile] " + err.message : err.message;
            const diag = new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Error);
            diag.source = "LumenHeadless";
            return diag;
        });

        diagnosticCollection.set(document.uri, diagnostics);
        outputChannel.appendLine("Validation found " + diagnostics.length + " error(s) in " + name);
        return diagnostics.length > 0;
    } catch (err) {
        outputChannel.appendLine("Validation request failed: " + err.message);
        throw err;
    } finally {
        statusBarItem.hide();
    }
}

function startValidationLoop() {
    stopValidationLoop();

    textChangeDisposable = vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.languageId === "lumen") {
            lastTypeTime = Date.now();
        }
    });

    validationTimer = setInterval(async () => {
        if (validationInFlight) return;

        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== "lumen") {
            stopValidationLoop();
            return;
        }

        if (Date.now() - lastTypeTime > 180000) {
            outputChannel.appendLine("Validation loop stopped: no typing for 180s");
            stopValidationLoop();
            return;
        }

        const currentSource = editor.document.getText();
        if (currentSource === lastValidatedSource) {
            return;
        }

        validationInFlight = true;
        try {
            const hasErrors = await validateDocument(editor.document);
            if (!hasErrors) {
                vscode.window.showInformationMessage("Lumen validation passed!");
                outputChannel.appendLine("Validation loop stopped: all errors resolved");
                stopValidationLoop();
            }
        } catch (err) {
            outputChannel.appendLine("Validation loop error: " + err.message);
            vscode.window.showErrorMessage("Lumen: validation stopped — " + err.message);
            stopValidationLoop();
        } finally {
            validationInFlight = false;
        }
    }, 2000);
}

function stopValidationLoop() {
    if (validationTimer) {
        clearInterval(validationTimer);
        validationTimer = null;
    }
    if (textChangeDisposable) {
        textChangeDisposable.dispose();
        textChangeDisposable = null;
    }
}

module.exports = { activate, deactivate };