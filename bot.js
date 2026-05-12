require("dotenv").config();
const express = require('express');
const mineflayer = require("mineflayer");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const Vec3 = require("vec3");
const fs = require("fs");

// --- 1. RENDER WEB SERVER ---
const app = express();
const PORT = process.env.PORT || 10000;

app.get(['/', '/health'], (req, res) => {
  res.status(200).send('AI Brain Status: Active');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`📡 Render Port Binding Successful on ${PORT}`);
});

// --- 2. GLOBAL CRASH PROTECTION ---
process.on('uncaughtException', (err) => {
  console.log(`🛡️ Shield: Caught ${err.code || 'Error'}. Maintaining process...`);
});

// --- 3. CONFIGURATION ---
let config;
try {
  config = JSON.parse(fs.readFileSync("config.json", "utf8"));
} catch (e) {
  config = { circleCenter: { x: 0, y: 87, z: 0 }, radius: 10, autoSleep: true, blockType: 'dirt' };
}

const botOptions = {
  host: "gameplanet.aternos.me",
  port: 16548,
  username: process.env.MINECRAFT_USERNAME || "Placer",
  version: "1.21.1",
  auth: "offline",
  // --- STEALTH & STABILITY SETTINGS ---
  checkTimeoutInterval: 90000, // 90 seconds
  connectTimeout: 90000,
  keepAlive: true,
  hideErrors: false
};

let bot;
let isProcessing = false;
let isSleeping = false;

function createBot() {
  if (bot) {
    bot.removeAllListeners();
    try { bot.end(); } catch (e) {}
    bot = null;
  }
  
  console.log(`🔄 AI Brain: Pinging ${botOptions.host}:${botOptions.port}...`);
  bot = mineflayer.createBot(botOptions);

  // Catch the ETIMEDOUT error here
  bot.on("error", (err) => {
    if (err.code === 'ETIMEDOUT') {
      console.log("⚠️ Aternos is ignoring the request (Timed Out). Retrying in 45s...");
    } else if (err.code === 'ECONNRESET') {
      console.log("⚠️ Link reset by server. Cooling down 60s...");
    } else {
      console.log(`⚠️ Connection Issue: ${err.message}`);
    }
  });

  setupBotHandlers();
}

createBot();

function setupBotHandlers() {
  bot.loadPlugin(pathfinder);

  bot.on("spawn", () => {
    console.log("✅ SUCCESS: AI Brain is inside the server.");
    isProcessing = false;
    isSleeping = false;
    
    const mcData = require("minecraft-data")(bot.version);
    const defaultMove = new Movements(bot, mcData);
    bot.pathfinder.setMovements(defaultMove);

    // Give Aternos 15s to load chunks before we move/chat
    setTimeout(() => {
      if (!bot?.entity) return;
      bot.chat("/gamemode creative");
      console.log("🛡️ Territory Protection Logic: RUNNING");
      startAILoop();
    }, 15000); 
  });

  bot.on("kicked", (reason) => {
    const r = reason.toString();
    console.log(`🚪 Kicked: ${r}`);
    const delay = r.includes("throttled") ? 60000 : 30000;
    setTimeout(createBot, delay);
  });

  bot.on("end", () => {
    console.log("🔌 Connection ended. Re-establishing in 30s...");
    setTimeout(createBot, 30000);
  });
}

// --- 4. TERRITORIAL CLEANING ---
async function cleanTerritory() {
  if (!bot?.entity) return;
  const blocks = bot.findBlocks({
    matching: (block) => block.name !== 'air' && !block.name.includes('bed'),
    maxDistance: (config.radius || 10) + 3,
    count: 3 
  }).filter(pos => pos.y >= 87);

  for (const pos of blocks) {
    const block = bot.blockAt(pos);
    if (block) {
      await bot.dig(block).catch(() => {});
      await delay(500); 
    }
  }
}

// --- 5. SMART SLEEP & WEATHER ---
async function handleSleepLogic() {
  if (isSleeping || !bot?.entity) return;
  isSleeping = true; isProcessing = true;
  bot.pathfinder.setGoal(null);
  
  bot.chat(`/tp ${config.circleCenter.x} ${config.circleCenter.y} ${config.circleCenter.z}`);
  await delay(2000);
  bot.chat("/kill @e[type=!player,distance=..15]");
  await delay(2000);

  const bed = bot.findBlock({ matching: b => b.name.includes('bed'), maxDistance: 25 });
  if (bed) {
    bot.chat(`/tp ${bed.position.x} ${bed.position.y + 1} ${bed.position.z}`);
    await delay(2000);
    for (let i = 0; i < 3; i++) {
      try {
        await bot.lookAt(bed.position.offset(0.5, 0.5, 0.5), true);
        await bot.sleep(bed);
        bot.once("wake", () => { isSleeping = false; isProcessing = false; startAILoop(); });
        return;
      } catch (e) { await delay(3000); }
    }
  }
  isSleeping = false; isProcessing = false;
}

// --- 6. AI WORKER LOOP ---
async function startAILoop() {
  if (isProcessing || isSleeping || !bot?.entity) return;
  
  // Check time/weather
  if (config.autoSleep && (bot.time.timeOfDay >= 13000 || bot.isRaining)) {
    await handleSleepLogic();
    return;
  }

  await cleanTerritory();
  isProcessing = true;
  try {
    await walkCircle(true);  // Clockwise circle
    await placeAndBreak();   // Feature 11/12
    await walkCircle(false); // Counter-circle
    await placeAndBreak();
  } catch (e) {}
  
  isProcessing = false;
  setImmediate(startAILoop);
}

async function walkCircle(clockwise) {
  const num = config.pointsPerCircle || 8;
  for (let i = 0; i < num; i++) {
    if (!bot?.entity || bot.isRaining || bot.time.timeOfDay >= 13000) return;
    const angle = (2 * Math.PI * i / num) * (clockwise ? 1 : -1);
    const p = {
      x: config.circleCenter.x + config.radius * Math.cos(angle),
      z: config.circleCenter.z + config.radius * Math.sin(angle)
    };
    bot.pathfinder.setGoal(new goals.GoalNear(p.x, config.circleCenter.y, p.z, 2.5));
    await waitForTarget(p);
  }
}

async function placeAndBreak() {
  if (!bot?.entity) return;
  const mcData = require("minecraft-data")(bot.version);
  const type = config.blockType || 'dirt';
  const item = bot.inventory.findInventoryItem(mcData.itemsByName[type].id);
  if (item) {
    await bot.equip(item, "hand");
    const ref = bot.blockAt(bot.entity.position.offset(0, -1, 1));
    await bot.placeBlock(ref, new Vec3(0, 1, 0)).catch(() => {});
    await delay(400);
    const target = bot.blockAt(bot.entity.position.offset(0, 0, 1));
    if (target && target.name !== 'air') await bot.dig(target).catch(() => {});
  }
}

async function waitForTarget(p) {
  return new Promise((res) => {
    const timer = setTimeout(res, 12000); // 12s timeout for Render lag
    const check = setInterval(() => {
      if (bot?.entity?.position.distanceTo(new Vec3(p.x, config.circleCenter.y, p.z)) < 3.5) {
        clearInterval(check); clearTimeout(timer); res();
      }
    }, 700);
  });
}

function delay(ms) { return new Promise(res => setTimeout(res, ms)); }
