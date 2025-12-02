const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");
const axios = require("axios");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "..")));

let minecraftData = null;
const clients = new Map();
const pttStates = new Map();

app.post("/minecraft-data", (req, res) => {
  minecraftData = req.body;
  console.log("📦 Datos de Minecraft recibidos");

  const muteStates = minecraftData.players?.map(player => ({
    gamertag: player.name,
    isMuted: player.data.isMuted,
    isDeafened: player.data.isDeafened,
    micVolume: player.data.micVolume
  })) || [];

  const pttStatesArray = Array.from(pttStates.entries()).map(([gamertag, state]) => ({
    gamertag,
    ...state
  }));

  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify({
        type: 'minecraft-update',
        data: minecraftData,
        muteStates: muteStates,
        pttStates: pttStatesArray
      }));
    }
  });

  res.json({ 
    success: true,
    pttStates: pttStatesArray
  });
});

function isGamertagTaken(gamertag) {
  for (const [_, clientData] of clients.entries()) {
    if (clientData.gamertag === gamertag) {
      return true;
    }
  }
  return false;
}

function broadcast(senderWs, message) {
  wss.clients.forEach(client => {
    if (client !== senderWs && client.readyState === 1) {
      client.send(JSON.stringify(message));
    }
  });
}

function broadcastToAll(message) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify(message));
    }
  });
}

wss.on("connection", (ws) => {
  console.log("🔌 Cliente conectado");

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.type === 'join') {
        if (isGamertagTaken(data.gamertag)) {
          console.log(`❌ Gamertag duplicado rechazado: ${data.gamertag}`);
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Gamertag already in use. Please choose a different one.'
          }));
          ws.close();
          return;
        }

        clients.set(ws, { gamertag: data.gamertag });
        
        pttStates.set(data.gamertag, { isTalking: true, isMuted: false });
        
        console.log(`👤 ${data.gamertag} se unió (${clients.size} usuarios en total)`);

        broadcast(ws, {
          type: 'join',
          gamertag: data.gamertag
        });

        const participantsList = Array.from(clients.values()).map(c => c.gamertag);
        
        ws.send(JSON.stringify({
          type: 'participants-list',
          list: participantsList
        }));

        broadcast(ws, {
          type: 'participants-list',
          list: participantsList
        });

        return;
      }

      if (data.type === 'leave') {
        const clientData = clients.get(ws);
        if (clientData) {
          console.log(`👋 ${clientData.gamertag} se fue (${clients.size - 1} usuarios restantes)`);

          broadcast(ws, {
            type: 'leave',
            gamertag: clientData.gamertag
          });

          pttStates.delete(clientData.gamertag);
          clients.delete(ws);
        }
        return;
      }

      if (data.type === 'ptt-status') {
        const gamertag = data.gamertag;
        const isTalking = data.isTalking;
        const isMuted = data.isMuted;

        pttStates.set(gamertag, { isTalking, isMuted });

        console.log(`🎙️ PTT: ${gamertag} → ${isTalking ? 'TALKING' : 'MUTED'}`);

        broadcastToAll({
          type: 'ptt-update',
          gamertag: gamertag,
          isTalking: isTalking,
          isMuted: isMuted
        });

        return;
      }

      if (data.type === 'voice-status') {
  const gamertag = data.gamertag;
  const isTalking = data.isTalking;

  console.log(`🎤 Voice: ${gamertag} → ${isTalking ? 'TALKING' : 'SILENT'}`);

  // Broadcast a todos (incluyendo Minecraft)
  broadcastToAll({
    type: 'voice-update',
    gamertag: gamertag,
    isTalking: isTalking
  });

  return;
}

      if (data.type === 'offer' || data.type === 'answer' || data.type === 'ice-candidate') {
        if (!data.to || !data.from) {
          console.warn(`⚠️ Mensaje sin 'to' o 'from':`, data.type);
          return;
        }

        const targetGamertag = data.to;
        let targetWs = null;
        
        for (const [clientWs, clientData] of clients.entries()) {
          if (clientData.gamertag === targetGamertag) {
            targetWs = clientWs;
            break;
          }
        }

        if (targetWs && targetWs.readyState === 1) {
          targetWs.send(JSON.stringify(data));
          
          if (data.type === 'ice-candidate') {
            console.log(`🧊 ICE ${data.from} → ${data.to}`);
          } else {
            console.log(`📨 ${data.type} de ${data.from} → ${data.to}`);
          }
        } else {
          console.warn(`⚠️ No se encontró destinatario: ${targetGamertag}`);
        }

        return;
      }

      if (data.type === 'heartbeat') {
        return;
      }

      if (data.type === 'request-participants') {
        const participantsList = Array.from(clients.values()).map(c => c.gamertag);
        
        ws.send(JSON.stringify({
          type: 'participants-list',
          list: participantsList
        }));
        
        broadcastToAll({
          type: 'participants-list',
          list: participantsList
        });
        
        console.log(`📋 Lista de participantes enviada (${participantsList.length} usuarios)`);
        return;
      }

      console.warn(`⚠️ Tipo de mensaje desconocido: ${data.type}`);

    } catch (e) {
      console.error("❌ Error procesando mensaje:", e);
    }
  });

  ws.on('close', () => {
    const clientData = clients.get(ws);
    if (clientData) {
      console.log(`🔌 ${clientData.gamertag} desconectado (${clients.size - 1} usuarios restantes)`);

      broadcast(ws, {
        type: 'leave',
        gamertag: clientData.gamertag
      });

      pttStates.delete(clientData.gamertag);
      clients.delete(ws);
      
      const updatedList = Array.from(clients.values()).map(c => c.gamertag);
      broadcastToAll({
        type: 'participants-list',
        list: updatedList
      });
    }
  });

  ws.on('error', (error) => {
    const clientData = clients.get(ws);
    const gamertag = clientData ? clientData.gamertag : 'Unknown';
    console.error(`❌ Error en WebSocket para ${gamertag}:`, error.message);
  });

  if (minecraftData) {
    ws.send(JSON.stringify({
      type: 'minecraft-update',
      data: minecraftData
    }));
  }
});

app.get("/health", (req, res) => {
  const status = {
    status: 'ok',
    connected_users: clients.size,
    minecraft_data: !!minecraftData,
    ptt_active_users: pttStates.size,
    uptime: process.uptime()
  };
  res.json(status);
});

app.get("/ptt-states", (req, res) => {
  const states = Array.from(pttStates.entries()).map(([gamertag, state]) => ({
    gamertag,
    ...state
  }));
  res.json({ pttStates: states });
});

process.on('SIGINT', () => {
  console.log('\n🛑 Apagando servidor...');
  
  broadcastToAll({ type: 'server-shutdown' });
  
  wss.clients.forEach(client => {
    client.close();
  });
  
  server.close(() => {
    console.log('✅ Servidor cerrado');
    process.exit(0);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 EnviroVoice Server v2.1`);
  console.log(`🌐 Servidor escuchando en puerto ${PORT}`);
  console.log(`📡 WebSocket: ws://localhost:${PORT}`);
  console.log(`🎮 Minecraft endpoint: POST http://localhost:${PORT}/minecraft-data`);
  console.log(`💚 Health check: GET http://localhost:${PORT}/health`);
  console.log(`🎙️ PTT states: GET http://localhost:${PORT}/ptt-states`);
});
