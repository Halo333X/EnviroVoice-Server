import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, "..")));

let minecraftData = null;
const clients = new Map(); // Map<WebSocket, { gamertag: string }>

// Endpoint para recibir datos de Minecraft
app.post("/minecraft-data", (req, res) => {
  minecraftData = req.body;
  console.log("📦 Datos de Minecraft recibidos");

  // Broadcast a todos los clientes
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify({
        type: 'minecraft-update',
        data: minecraftData
      }));
    }
  });

  res.json({ success: true });
});

wss.on("connection", (ws) => {
  console.log("🔌 Cliente conectado");

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      
      // Guardar gamertag del cliente
      if (data.type === 'join') {
        clients.set(ws, { gamertag: data.gamertag });
        console.log(`👤 ${data.gamertag} se unió`);
        
        // Notificar a todos los demás
        wss.clients.forEach(client => {
          if (client !== ws && client.readyState === 1) {
            client.send(JSON.stringify({
              type: 'join',
              gamertag: data.gamertag
            }));
          }
        });
        
        // Enviar lista actual de participantes al nuevo cliente
        const participantsList = Array.from(clients.values()).map(c => c.gamertag);
        ws.send(JSON.stringify({
          type: 'participants-list',
          list: participantsList
        }));
        
        return;
      }
      
      // Manejar desconexión
      if (data.type === 'leave') {
        const clientData = clients.get(ws);
        if (clientData) {
          console.log(`👋 ${clientData.gamertag} se fue`);
          
          // Notificar a todos
          wss.clients.forEach(client => {
            if (client !== ws && client.readyState === 1) {
              client.send(JSON.stringify({
                type: 'leave',
                gamertag: clientData.gamertag
              }));
            }
          });
          
          clients.delete(ws);
        }
        return;
      }
      
      // Señalización WebRTC - reenviar solo al destinatario
      if (data.type === 'offer' || data.type === 'answer' || data.type === 'ice-candidate') {
        if (!data.to || !data.from) {
          console.warn(`⚠️ Mensaje sin 'to' o 'from':`, data.type);
          return;
        }
        
        const targetGamertag = data.to;
        
        // Buscar el WebSocket del destinatario
        let targetWs = null;
        for (const [clientWs, clientData] of clients.entries()) {
          if (clientData.gamertag === targetGamertag) {
            targetWs = clientWs;
            break;
          }
        }
        
        if (targetWs && targetWs.readyState === 1) {
          targetWs.send(JSON.stringify(data));
          console.log(`📨 ${data.type} de ${data.from} → ${data.to}`);
        } else {
          console.warn(`⚠️ No se encontró destinatario: ${targetGamertag}`);
        }
        
        return;
      }
      
      // Heartbeat (ignorar)
      if (data.type === 'heartbeat') return;
      
      // Request participants
      if (data.type === 'request-participants') {
        const participantsList = Array.from(clients.values()).map(c => c.gamertag);
        ws.send(JSON.stringify({
          type: 'participants-list',
          list: participantsList
        }));
        return;
      }
      
    } catch (e) {
      console.error("Error procesando mensaje:", e);
    }
  });
  
  ws.on('close', () => {
    const clientData = clients.get(ws);
    if (clientData) {
      console.log(`🔌 ${clientData.gamertag} desconectado`);
      
      // Notificar a todos
      wss.clients.forEach(client => {
        if (client.readyState === 1) {
          client.send(JSON.stringify({
            type: 'leave',
            gamertag: clientData.gamertag
          }));
        }
      });
      
      clients.delete(ws);
    }
  });
  
  // Enviar datos de Minecraft si existen
  if (minecraftData) {
    ws.send(JSON.stringify({
      type: 'minecraft-update',
      data: minecraftData
    }));
  }
});

server.listen(3000, () => {
  console.log("🌐 Servidor escuchando en puerto 3000");
  console.log("📡 WebSocket: ws://localhost:3000");
  console.log("🎮 Minecraft endpoint: POST http://localhost:3000/minecraft-data");
});