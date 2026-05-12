require("dotenv").config();
const express = require('express');
const mineflayer = require("mineflayer");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const Vec3 = require("vec3");
const fs = require("fs");

// --- 1. RENDER KEEP-ALIVE SERVER ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('<h1>AI Brain Online</h1><p>Territorial Protection and 14 Features Active.</p>');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`📡 Render Port Binding Successful on ${PORT}`);
});

// --- 2. CONFIGURATION LOAD ---
let config;
try {
  config = JSON.parse(fs.readFileSync("config.json", "utf8"));
} catch (error) {
  console.log("⚠️ Config.json not found. Using default territory values.");
  config = {
    circleCenter: { x: 0, y: 87, z: 0 },
    radius: 10,
    autoSleep: true,
    blockType: 'dirt',
    pointsPerCircle: 8
  };
}

const botOptions = {
  host: process.env.MINECRAFT_HOST || "gameplanet.aternos.me",
  port: 16548,
  username: process.env.MINECRAFT_USERNAME || "Placer",
  version: "1.21.1",
  auth: "offline",
};

let bot;
let isProcessing = false;
let isSleeping = false;
let creativeInventoryLock = false;

// --- 3. ROBUST RECONNECT & ERROR HANDLING ---
function createBot() {
  if (bot) {
    bot.removeAllListeners();
    try { bot.quit(); } catch (e) {}
    bot = null;
  }
  
  console.log("🔄 AI Brain: Establishing secure link...");
  bot = mineflayer.createBot(botOptions);

  bot.on("error", (err) => {
    if (err.code === 'ECONNRESET') {
      console.log("⚠️ Connection Reset (ECONNRESET). Cooling down...");
    } else {
      console.log(`⚠️ AI Brain Alert: ${err.message}`);
    }
  });

  setupBotHandlers();
}

createBot();

function setupBotHandlers() {
  bot.loadPlugin(pathfinder);

  bot.on("spawn", () => {
    console.log("✅ AI Brain Online. Features Initializing...");
    isProcessing = false;
    isSleeping = false;
    
    const mcData = require("minecraft-data")(bot.version);
    const defaultMove = new Movements(bot, mcData);
    bot.pathfinder.setMovements(defaultMove);

    // 10-second stability delay for Aternos/Render
    setTimeout(async () => {
      if (!bot || !bot.entity) return;
      console.log("🛡️ Protection Activated.");
      bot.chat("/gamemode creative");
      startAILoop();
    }, 10000); 
  });

  bot.on("kicked", (reason) => {
    console.log("🚪 Kicked from server. Retrying in 30s...");
    setTimeout(createBot, 30000);
  });

  bot.on("end", () => {
    console.log("🔌 Connection lost. Retrying in 30s...");
    setTimeout(createBot, 30000);
  });
}

// --- 4. TERRITORIAL CLEANING (Destroy players blocks above Y 87) ---
async function cleanTerritory() {
  if (!bot || !bot.entity) return;
  const blocks = bot.findBlocks({
    matching: (block) => block.name !== 'air' && !block.name.includes('bed'),
    maxDistance: (config.radius || 10) + 4,
    count: 8 
  }).filter(pos => pos.y >= 87);

  for (const pos of blocks) {
    const block = bot.blockAt(pos);
    if (block) {
      await bot.dig(block).catch(() => {});
      await delay(350); // Prevent FastBreak kicks
    }
  }
}

// --- 5. SMART SLEEP (3 Clicks Weather Trick) ---
async function handleSleepLogic() {
  if (isSleeping || !bot || !bot.entity) return;
  isSleeping = true;
  isProcessing = true;
  bot.pathfinder.setGoal(null);

  bot.chat(`/tp ${config.circleCenter.x} ${config.circleCenter.y} ${config.circleCenter.z}`);
  await delay(2000);
  bot.chat("/kill @e[type=!player,distance=..15]"); // Clear monsters before sleep
  await delay(2000);

  const bedNames = ["red_bed", "white_bed", "blue_bed", "yellow_bed", "black_bed"];
  let bed = bot.findBlock({ matching: b => bedNames.includes(b.name), maxDistance: 25 });

  if (bed) {
    bot.chat(`/tp ${bed.position.x} ${bed.position.y + 1} ${bed.position.z}`);
    await delay(1500);
    
    for (let i = 0; i < 3; i++) { // Click bed 3 times trick
      try {
        await bot.lookAt(bed.position.offset(0.5, 0.5, 0.5), true);
        await bot.sleep(bed);
        bot.once("wake", () => {
          isSleeping = false; isProcessing = false;
          startAILoop();
        });
        return;
      } catch (e) { 
        console.log(`🛌 Sleep attempt ${i+1}/3 failed...`);
        await delay(2000); 
      }
    }
  }
  isSleeping = false; isProcessing = false;
}

// --- 6. COMBAT & AI LOOP ---
async function combatScan() {
  if (!bot || !bot.entity) return;
  const target = bot.nearestEntity((e) => {
    if (e.type !== 'mob') return false;
    const hostiles = ['zombie', 'skeleton', 'spider', 'creeper', 'pillager'];
    const dist = e.position.distanceTo(new Vec3(config.circleCenter.x, config.circleCenter.y, config.circleCenter.z));
    return hostiles.some(h => e.name.toLowerCase().includes(h)) && dist <= ((config.radius || 10) + 1.5);
  });
  if (target) {
    await bot.lookAt(target.position.offset(0, 1.2, 0));
    bot.attack(target);
  }
}

async function startAILoop() {
  if (isProcessing || isSleeping || !bot || !bot.entity) return;

  if (config.autoSleep && (bot.time.timeOfDay >= 13000 || bot.isRaining)) {
    await handleSleepLogic();
    return;
  }

  await combatScan();
  await cleanTerritory();

  isProcessing = true;
  try {
    await walkCircle(true);  // Clockwise
    await placeAndBreak();
    await walkCircle(false); // Anti-clockwise
    await placeAndBreak();
  } catch (e) {}
  
  isProcessing = false;
  setImmediate(startAILoop);
}

async function walkCircle(clockwise) {
  const num = config.pointsPerCircle || 8;
  for (let i = 0; i < num; i++) {
    if (!bot || !bot.entity || bot.isRaining || bot.time.timeOfDay >= 13000) return;
    const angle = (2 * Math.PI * i / num) * (clockwise ? 1 : -1);
    const p = {
      x: config.circleCenter.x + (config.radius || 10) * Math.cos(angle),
      z: config.circleCenter.z + (config.radius || 10) * Math.sin(angle)
    };
    bot.pathfinder.setGoal(new goals.GoalNear(p.x, config.circleCenter.y, p.z, 2.5));
    await waitForTarget(p);
    await combatScan();
  }
}

async function placeAndBreak() {
  if (!bot || !bot.entity) return;
  const mcData = require("minecraft-data")(bot.version);
  const type = config.blockType || 'dirt';
  await ensureCreativeItem(type, 1);
  const item = bot.inventory.findInventoryItem(mcData.itemsByName[type].id);
  if (item) {
    await bot.equip(item, "hand");
    const ref = bot.blockAt(bot.entity.position.offset(0, -1, 1));
    await bot.placeBlock(ref, new Vec3(0, 1, 0)).catch(() => {});
    await delay(250); // Immediate destroy
    const target = bot.blockAt(bot.entity.position.offset(0, 0, 1));
    if (target && target.name !== 'air') await bot.dig(target).catch(() => {});
  }
}

async function waitForTarget(p) {
  return new Promise((res) => {
    const timer = setTimeout(res, 8000);
    const check = setInterval(() => {
      if (bot && bot.entity && bot.entity.position.distanceTo(new Vec3(p.x, config.circleCenter.y, p.z)) < 3) {
        clearInterval(check); clearTimeout(timer); res();
      }
    }, 500);
  });
}

async function ensureCreativeItem(name, count) {
  if (!bot || !bot.creative) return;
  const mcData = require("minecraft-data")(bot.version);
  const item = mcData.itemsByName[name];
  if (item && !bot.inventory.findInventoryItem(item.id)) {
    await bot.creative.setInventorySlot(36, new (require("prismarine-item")(bot.version))(item.id, count));
  }
}

function delay(ms) { return new Promise(res => setTimeout(res, ms)); }
