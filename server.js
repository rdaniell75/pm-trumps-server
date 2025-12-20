const express = require('express');
const app = express();
const cors = require('cors');
app.use(cors());
app.use(express.json());

const path = require('path');
app.use(express.static(path.join(__dirname)));

const http = require('http').createServer(app);
const WebSocket = require('ws');
const wss = new WebSocket.Server({ server: http });

const fs = require('fs');
const { parse } = require('csv-parse/sync');

// Labels for stats
const STAT_LABELS = {
  TimeInOfficeDays: "Time in Office",
  AgeAtPM: "Age at PM",
  TimeAsMPYears: "Time as MP",
  Peerage: "Peerage",
  Age: "Age",
};

const rooms = {};

// Load cards from CSV
let allCards = [];
try {
  const csvPath = path.join(__dirname, 'UK_Prime_Ministers.csv');
  const csvContent = fs.readFileSync(csvPath, 'utf8');
  const rows = parse(csvContent, { columns: true, skip_empty_lines: true });
  allCards = rows.filter(c => c && c.ImageFileName && String(c.ImageFileName).trim() !== "");
  console.log(`Server loaded ${allCards.length} valid cards`);
} catch (err) {
  console.error('Server CSV load failed:', err);
  allCards = [];
}

// --- Helpers ---
function safeNumber(value) {
  const num = parseFloat(value);
  return isNaN(num) ? 0 : num;
}

function peerageRank(title) {
  if (!title) return 0;
  const normalized = title.toLowerCase();
  if (normalized.includes("duke")) return 6;
  if (normalized.includes("marquess")) return 5;
  if (normalized.includes("earl")) return 4;
  if (normalized.includes("viscount")) return 3;
  if (normalized.includes("baron")) return 2;
  if (normalized.includes("knight")) return 1;
  return 0;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function dealCardsToPlayers(room) {
  const shuffled = shuffle([...allCards]);
  const valid = shuffled.filter(c => c && c.ImageFileName && String(c.ImageFileName).trim() !== "");

  const numPlayers = room.players.length;
  const cardsPerPlayer = Math.floor(valid.length / numPlayers);
  const totalToDeal = cardsPerPlayer * numPlayers;

  room.players.forEach(p => { p.deck = []; });

  for (let i = 0; i < totalToDeal; i++) {
    const idx = i % numPlayers;
    room.players[idx].deck.push(valid[i]);
  }

  room.unusedPile = valid.slice(totalToDeal);
  room.totalDealt = totalToDeal;

  console.log("[dealCardsToPlayers] counts:", room.players.map(p => ({ id: p.id, name: p.name, count: p.deck.length })));
}

function rebalanceDecksPreservingTop(room) {
  const preservedTops = room.players.map(p => {
    const top = p.deck.length ? p.deck[0] : null;
    if (p.deck.length) p.deck.shift();
    return top;
  });

  const remaining = [];
  room.players.forEach(p => remaining.push(...p.deck));
  shuffle(remaining);

  room.players.forEach(p => { p.deck = []; });

  room.players.forEach((p, i) => {
    if (!preservedTops[i] && remaining.length > 0) {
      preservedTops[i] = remaining.shift();
    }
    if (preservedTops[i]) p.deck.push(preservedTops[i]);
  });

  const numPlayers = room.players.length;
  const cardsPerPlayer = Math.floor(remaining.length / numPlayers);
  const totalToDeal = cardsPerPlayer * numPlayers;
  for (let i = 0; i < totalToDeal; i++) {
    const idx = i % numPlayers;
    room.players[idx].deck.push(remaining[i]);
  }

  room.unusedPile = remaining.slice(totalToDeal);
  room.totalDealt = room.players.reduce((sum, p) => sum + p.deck.length, 0);
}

function broadcast(room, payload) {
  const msg = JSON.stringify(payload);
  room.players.forEach(p => { if (p.ws) p.ws.send(msg); });
}

// --- Routes ---
app.post('/rooms', (req, res) => {
  const code = Math.random().toString(36).slice(2, 7).toUpperCase();
  const name = req.body.name || 'Player 1';
  rooms[code] = {
    players: [{ id: 1, name, ws: null, deck: [] }],
    tiePile: [],
    dealt: false,
    currentPlayer: 0,
    awaitNextRound: false,
    roundOutcome: null,        // { winnerIndex: number|null, stat: string }
    tiePending: false,         // true if last round was a tie and we need to collect cards next-round
    totalDealt: 0,
  };

  dealCardsToPlayers(rooms[code]);
  rooms[code].dealt = true;

  broadcast(rooms[code], {
    type: 'room-state',
    code,
    players: rooms[code].players.map(p => ({ id: p.id, name: p.name, deck: p.deck })),
    currentPlayer: rooms[code].currentPlayer
  });

  res.json({ code, players: rooms[code].players });
});

app.post('/rooms/join', (req, res) => {
  const { code, name } = req.body;
  if (!rooms[code]) return res.status(404).json({ error: 'Room not found' });

  const room = rooms[code];
  if (room.players.length >= 6) {
    return res.status(400).json({ error: 'Room is full (max 6 players)' });
  }

  const playerId = room.players.length + 1;
  const newPlayer = { id: playerId, name: name || `Player ${playerId}`, ws: null, deck: [] };
  room.players.push(newPlayer);

  if (room.dealt) {
    rebalanceDecksPreservingTop(room);
  } else {
    dealCardsToPlayers(room);
    room.dealt = true;
  }

  broadcast(room, {
    type: 'room-state',
    code,
    players: room.players.map(p => ({ id: p.id, name: p.name, deck: p.deck })),
    currentPlayer: room.currentPlayer ?? 0
  });

  broadcast(room, {
    type: 'player-list',
    players: room.players.map(p => ({ id: p.id, name: p.name }))
  });

  res.json({ playerId, players: room.players });
});

// --- WebSocket handling ---
wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    let data;
    try { data = JSON.parse(message); } catch { return; }

    if (data.type === 'join-room') {
      const room = rooms[data.code];
      if (!room) return;
      const player = room.players.find(p => p.id === parseInt(data.playerId, 10));
      if (player) {
        player.ws = ws;
        if (data.name) player.name = data.name;
      }
      broadcast(room, {
        type: 'room-state',
        code: data.code,
        players: room.players.map(p => ({ id: p.id, name: p.name, deck: p.deck })),
        currentPlayer: room.currentPlayer ?? 0
      });
      broadcast(room, {
        type: 'player-list',
        players: room.players.map(p => ({ id: p.id, name: p.name }))
      });
    }

    // Choose a stat: announce winner/tie but DO NOT remove/flip cards yet
    if (data.type === 'play-round') {
      const room = rooms[data.code];
      if (!room) return;

      if (room.awaitNextRound) {
        broadcast(room, {
          type: 'round-result',
          code: data.code,
          stat: null,
          players: room.players.map(p => ({ id: p.id, name: p.name, deck: p.deck })),
          winner: null,
          message: 'Click Next Round to continue',
          currentPlayer: room.currentPlayer,
          awaitNextRound: room.awaitNextRound,
        });
        return;
      }

      const topCards = room.players.map(p => p.deck[0] || null);
      const getValue = (card) => {
        if (!card) return Number.NEGATIVE_INFINITY;
        if (data.stat === "Peerage") return peerageRank(card.Peerage);
        return safeNumber(card[data.stat]);
      };

      const values = topCards.map(getValue);
      const validValues = values.filter(v => v !== Number.NEGATIVE_INFINITY);
      const maxValue = validValues.length ? Math.max(...validValues) : Number.NEGATIVE_INFINITY;
      const indicesWithMax = values.map((v, i) => ({ v, i }))
        .filter(x => x.v === maxValue)
        .map(x => x.i);

      const tied = maxValue !== Number.NEGATIVE_INFINITY && indicesWithMax.length > 1;
      const roundWinnerIndex = (!tied && maxValue !== Number.NEGATIVE_INFINITY) ? indicesWithMax[0] : null;

      // Store outcome for next-round to process movement
      room.roundOutcome = { winnerIndex: roundWinnerIndex, stat: data.stat };
      room.tiePending = tied;

      // Turn logic (who chooses next stat)
      room.currentPlayer = (room.currentPlayer ?? 0);
      if (roundWinnerIndex !== null) {
        room.currentPlayer = roundWinnerIndex;
      } else if (tied) {
        room.currentPlayer = room.currentPlayer; // attacker chooses again
      } else {
        room.currentPlayer = (room.currentPlayer + 1) % room.players.length;
      }

      const statLabel = STAT_LABELS[data.stat] || data.stat;
      const messageText = tied
        ? "It's a tie. Attacker chooses again"
        : (roundWinnerIndex !== null
            ? `${room.players[roundWinnerIndex].name} wins - ${statLabel}`
            : "No winner this round.");

      let winnerId = null;
      if (roundWinnerIndex !== null) {
        winnerId = room.players[roundWinnerIndex].id;
      }

      room.awaitNextRound = true;

      broadcast(room, {
        type: 'round-result',
        code: data.code,
        stat: data.stat,
        players: room.players.map(p => ({ id: p.id, name: p.name, deck: p.deck })), // unchanged decks
        winner: winnerId,
        message: messageText,
        currentPlayer: room.currentPlayer,
        awaitNextRound: room.awaitNextRound,
      });
    }

    // Next round: NOW remove/flip cards and award to winner or tie pile
    if (data.type === 'next-round') {
      const room = rooms[data.code];
      if (!room) return;

      if (!room.awaitNextRound) {
        broadcast(room, {
          type: 'round-result',
          code: data.code,
          stat: null,
          players: room.players.map(p => ({ id: p.id, name: p.name, deck: p.deck })),
          winner: null,
          message: 'Round already in progress',
          currentPlayer: room.currentPlayer,
          awaitNextRound: room.awaitNextRound,
        });
        return;
      }

      const outcome = room.roundOutcome || { winnerIndex: null, stat: null };
      const tied = room.tiePending === true;

      if (tied) {
        // Collect each player's top card into tie pile
        room.players.forEach(p => {
          if (p.deck.length > 0) {
            const card = p.deck.shift();
            room.tiePile.push(card);
          }
        });
        room.tiePending = false; // tie cards collected; attacker still chooses again next play-round
      } else if (outcome.winnerIndex !== null) {
        // Winner takes all top cards + tie pile
        const winner = room.players[outcome.winnerIndex];
        const taken = [];
        room.players.forEach(p => {
          if (p.deck.length > 0) {
            const card = p.deck.shift();
            taken.push(card);
          }
        });
        if (room.tiePile.length > 0) {
          taken.push(...room.tiePile);
          room.tiePile.length = 0;
        }
        winner.deck.push(...taken);
      } else {
        // No valid winner and not tied: remove nothing
      }

      // Clear gate and outcome
      room.awaitNextRound = false;
      room.roundOutcome = null;

      // Broadcast updated state for new round
      broadcast(room, {
        type: 'round-result',
        code: data.code,
        stat: null,
        players: room.players.map(p => ({ id: p.id, name: p.name, deck: p.deck })),
        winner: null,
        message: 'Next round started',
        currentPlayer: room.currentPlayer,
        awaitNextRound: room.awaitNextRound,
      });

      // Game-over checks after movement
      const activePlayers = room.players.filter(p => p.deck.length > 0);
      const singlePlayerLeft = activePlayers.length === 1;
      const totalDealt = room.totalDealt || room.players.reduce((s, p) => s + p.deck.length, 0);
      const holderOfAllCards = room.players.find(p => p.deck.length === totalDealt) || null;

      if (singlePlayerLeft || holderOfAllCards) {
        const champion = holderOfAllCards || activePlayers[0];
        broadcast(room, {
          type: "game-over",
          code: data.code,
          winner: champion.id,
          message: `${champion.name} is the new Prime Minister!`,
        });
      }
    }
  }); // closes ws.on('message', …)

  ws.on('close', () => {
    // Optional cleanup
  });
}); // closes wss.on('connection', …)

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
