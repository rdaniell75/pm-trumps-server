// --- Global state ---
let players = [];
let currentPlayer = 0;
let numPlayers = 0;
let roomCode = null;
let playerId = null;

let playerName = localStorage.getItem("playerName") || null;
let ws = null;

// --- Helpers ---
function getCardImage(card) {
  if (card && card.ImageFileName) {
    return `images/${card.ImageFileName}`;
  }
  return "images/card_back.png";
}

function showCardFront(card, containerId) {
  const cardEl = document.getElementById(containerId);
  const img = cardEl.querySelector(".flip-card-front img");
  if (card && card.ImageFileName) {
    img.src = getCardImage(card);
    img.alt = card.Name || "Card";
  } else {
    img.src = "images/card_back.png";
    img.alt = "Card back";
  }
}

function setBackToBack(containerId) {
  const cardEl = document.getElementById(containerId);
  const img = cardEl.querySelector(".flip-card-back img");
  img.src = "images/card_back.png";
  img.alt = "Card back";
}

function setFrontToBack(containerId) {
  const cardEl = document.getElementById(containerId);
  const img = cardEl.querySelector(".flip-card-front img");
  img.src = "images/card_back.png";
  img.alt = "Card back";
}

function showTopCards() {
  const myPlayer = players.find(p => p.id === playerId);
  if (!myPlayer) return;

  const cardEl = document.getElementById("card1");
  if (!cardEl) return;

  document.querySelectorAll(".card-slot").forEach(el => { el.style.display = "none"; });
  cardEl.style.display = "block";
  cardEl.classList.remove("flipped", "winner", "tie");

  const topCard = myPlayer.deck[0] || null;
  if (topCard) {
    showCardFront(topCard, "card1");
  } else {
    setFrontToBack("card1");
  }
  setBackToBack("card1");
}

function updateTurnIndicator() {
  const indicatorEl = document.getElementById("turn-indicator");
  if (!indicatorEl) return;

  const current = players[currentPlayer];
  indicatorEl.textContent = current ? `Turn: ${current.name}` : "";

  const isMyTurn = (current && current.id === playerId);
  document.querySelectorAll("#card1 .card-buttons button").forEach(btn => {
    btn.disabled = !isMyTurn;
  });
}

// --- Server interaction ---
async function createRoom() {
  let roomCreated = false;
  if (roomCreated) return;
  roomCreated = true;

  try {
    const nameInput = document.getElementById("playerName");
    playerName = (nameInput && nameInput.value && nameInput.value.trim()) ? nameInput.value.trim() : "Player 1";
    localStorage.setItem("playerName", playerName);

    const res = await fetch("https://pm-trumps-server.fly.dev/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: playerName })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    players = Array.isArray(data.players) ? data.players : [];
    numPlayers = players.length;
    roomCode = data.code;
    playerId = 1;

    const roomDisplayEl = document.getElementById("room-display");
    if (roomDisplayEl) {
      roomDisplayEl.textContent = `Room code: ${roomCode} | Player: ${playerName}`;
    }

    showTopCards();
    connectWebSocket();
  } catch (err) {
    console.error("Create room failed:", err);
    alert("Create room failed. Is the server running on http://pm-trumps-server.fly.dev?");
  }

  document.getElementById("history-list").innerHTML = "";
  window.roundCounter = 0;
}

function connectWebSocket() {
  const ws = new WebSocket("wss://pm-trumps-server.fly.dev");

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: "join-room",
      code: roomCode,
      playerId,
      name: playerName
    }));
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    console.log("ws message:", msg);

    // Round result: announce winner/tie; decks are unchanged until next-round
    if (msg.type === "round-result") {
      players = msg.players;
      currentPlayer = msg.currentPlayer ?? 0;

      const isAwaiting = !!msg.awaitNextRound;
      const current = players[currentPlayer];
      const isMyTurn = (current && current.id === playerId);

      const historyList = document.getElementById("history-list");
      if (historyList) {
        if (typeof window.roundCounter === "undefined") window.roundCounter = 0;

        if (msg.stat !== null) {
          if (!window.currentRoundStarted) {
            window.roundCounter++;
            const roundItem = document.createElement("li");
            roundItem.textContent = `Round ${window.roundCounter}`;
            historyList.appendChild(roundItem);
            window.currentRoundStarted = true;
          }
          const infoLine = document.createElement("div");
          infoLine.style.marginLeft = "20px";
          infoLine.textContent = (msg.winner === null) ? `Tie - ${msg.stat}` : msg.message;
          historyList.appendChild(infoLine);

          const detailLine = document.createElement("div");
          detailLine.style.marginLeft = "20px";
          historyList.appendChild(detailLine);
        }

        if (msg.stat === null && msg.message === "Next round started") {
          window.currentRoundStarted = false;
        }
      }

      // Decks only change on "Next round started", so showTopCards keeps the same top card until then
      showTopCards();
      updateTurnIndicator();

      const messageEl = document.getElementById("comparison-message");
      if (messageEl) {
        messageEl.textContent = msg.message;
        messageEl.className = (msg.winner === null) ? "message-tie" : "message-win";
      }

      // Disable stat buttons if not your turn OR the server is awaiting Next Round
      document.querySelectorAll("#card1 .card-buttons button").forEach(btn => {
        btn.disabled = !isMyTurn || isAwaiting;
      });

      // Enable Next Round only when awaiting
      const nextRoundBtn = document.querySelector("#game-controls button[onclick='nextRound()']");
      if (nextRoundBtn) nextRoundBtn.disabled = !isAwaiting;

      const winnerBanner = document.querySelector("#card1 .winner-banner");
      if (winnerBanner) {
        winnerBanner.style.display = (msg.winner !== null && msg.winner === playerId) ? "block" : "none";
      }

      const tieBanner = document.querySelector("#card1 .tie-banner");
      if (tieBanner) {
        tieBanner.style.display = (msg.winner === null && msg.stat !== null) ? "block" : "none";
      }

      const listEl = document.getElementById("player-list");
      if (listEl) {
        listEl.innerHTML = "";
        msg.players.forEach(p => {
          const li = document.createElement("li");
          li.textContent = `${p.name} (${p.deck.length} cards)`;
          listEl.appendChild(li);
        });
      }
    }

// Game over
if (msg.type === "game-over") {
  const messageEl = document.getElementById("comparison-message");
  if (messageEl) {
    messageEl.textContent = msg.message;
    messageEl.className = "message-win";
  }

  const historyList = document.getElementById("history-list");
  if (historyList) {
    const roundItem = document.createElement("li");
    roundItem.textContent = "Game Over";
    historyList.appendChild(roundItem);

    const infoLine = document.createElement("div");
    infoLine.style.marginLeft = "20px";
    infoLine.textContent = msg.message;
    historyList.appendChild(infoLine);
  }

  const cardEl = document.getElementById("card1");
  if (cardEl) {
    const imgFront = cardEl.querySelector(".flip-card-front img");
    const nameEl = document.getElementById("card1-player-name");

    if (imgFront) {
      if (msg.winner === playerId) {
        // Show winning card
        imgFront.src = "images/Winning_Prime_Minister.png";
        imgFront.alt = "Winning Prime Minister";
      } else {
        // Show losing card
        imgFront.src = "images/Losing_Prime_Minister.png";
        imgFront.alt = "Losing Prime Minister";
      }
    }

    // Show the player’s name at the top of the card
    if (nameEl) {
      nameEl.textContent = playerName;
      nameEl.style.display = "block";
    }
  }

  // Disable all stat buttons
  document.querySelectorAll("#card1 .card-buttons button").forEach(btn => {
    btn.disabled = true;
  });

  // Disable Next Round button
  const nextRoundBtn = document.querySelector("#game-controls button[onclick='nextRound()']");
  if (nextRoundBtn) nextRoundBtn.disabled = true;
}

    // Player list names sync
    if (msg.type === "player-list") {
      const listEl = document.getElementById("player-list");
      if (listEl) {
        listEl.innerHTML = "";
        msg.players.forEach(p => {
          const playerData = players.find(pl => pl.id === p.id);
          const count = playerData ? playerData.deck.length : 0;
          const li = document.createElement("li");
          li.textContent = `${p.name} (${count} cards)`;
          listEl.appendChild(li);
        });
      }
    }
  };
}

async function joinRoom() {
  try {
    const codeInput = document.getElementById("roomCode");
    const codeValue = codeInput?.value?.trim();
    if (!codeValue) {
      alert("Please enter a room code to join.");
      return;
    }
    roomCode = codeValue;

    const nameInput = document.getElementById("playerName");
    playerName = nameInput?.value?.trim() || "Player";
    localStorage.setItem("playerName", playerName);

    const res = await fetch("https://pm-trumps-server.fly.dev/rooms/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: roomCode, name: playerName })
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error);

    players = Array.isArray(data.players) ? data.players : [];
    numPlayers = players.length;
    playerId = data.playerId;

    const roomDisplayEl = document.getElementById("room-display");
    if (roomDisplayEl) {
      roomDisplayEl.textContent = `Room code: ${roomCode} | Player: ${playerName}`;
    }

    showTopCards();
    connectWebSocket();
  } catch (err) {
    console.error("Join room failed:", err);
    alert("Join room failed. Is the server running and is the code correct?");
  }

  document.getElementById("history-list").innerHTML = "";
  window.roundCounter = 0;
}

function playRound(stat) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "play-round", code: roomCode, stat }));
}

window.addEventListener("DOMContentLoaded", () => {
  const savedName = localStorage.getItem("playerName");
  if (savedName) {
    const nameInput = document.getElementById("playerName");
    if (nameInput) nameInput.value = savedName;
  }

  // Keyboard shortcuts
document.addEventListener("keydown", (event) => {
  // Use event.code for space bar
  if (event.code === "Space") {
    nextRound();
  }

  if (event.key.toUpperCase() === "R") {
    if (typeof restartGame === "function") {
      restartGame();
    }
  }
});

});

function nextRound() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    type: "next-round",
    code: roomCode
  }));
}
