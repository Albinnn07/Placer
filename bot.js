require("dotenv").config();
const mineflayer = require("mineflayer");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const Vec3 = require("vec3");
const fs = require("fs");

let config;
try {
  config = JSON.parse(fs.readFileSync("config.json", "utf8"));
} catch (error) {
  console.error("Error reading config.json:", error.message);
  process.exit(1);
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

function createBot() {
  if (bot) bot.removeAllListeners();
  bot = mineflayer.createBot(botOptions);
  setupBotHandlers();
}

createBot();

function setupBotHandlers() {
  bot.loadPlugin(pathfinder);

  bot.on("spawn", () => {
    console.log("✅ AI Brain Online. Territorial Protection Active.");
    isProcessing = false;
    isSleeping = false;
    
    const mcData = require("minecraft-data")(bot.version);
    const defaultMove = new Movements(bot, mcData);
    bot.pathfinder.setMovements(defaultMove);

    setTimeout(async () => {
      bot.chat("/gamemode creative");
      startAILoop();
    }, 2000);
  });

  bot.on("kicked", () => setTimeout(createBot, 10000));
  bot.on("end", () => setTimeout(createBot, 10000));
}

// --- TERRITORIAL CLEANING (FEATURE 3 & 9) ---
async function cleanTerritory() {
  const center = new Vec3(config.circleCenter.x, config.circleCenter.y, config.circleCenter.z);
  // Scan for any blocks above Y 87 within the circle radius
  const blocksToClear = bot.findBlocks({
    matching: (block) => block.name !== 'air' && !block.name.includes('bed'),
    maxDistance: config.radius + 5,
    count: 20
  }).filter(pos => pos.y >= 87);

  for (const pos of blocksToClear) {
    const block = bot.blockAt(pos);
    if (block) {
      await bot.dig(block).catch(() => {});
      await delay(100);
    }
  }
}

// --- SMART SLEEP LOGIC (FEATURE 5 & 12) ---
async function handleSleepLogic() {
  if (isSleeping) return;
  isSleeping = true;
  isProcessing = true;
  bot.pathfinder.setGoal(null);

  bot.chat(`/tp ${config.circleCenter.x} ${config.circleCenter.y} ${config.circleCenter.z}`);
  await delay(500);
  bot.chat("/kill @e[type=!player,distance=..15]");
  await delay(800);

  const bedNames = ["red_bed", "white_bed", "blue_bed", "yellow_bed"];
  let bed = bot.findBlock({ matching: b => bedNames.includes(b.name), maxDistance: 25 });

  if (bed) {
    bot.chat(`/tp ${bed.position.x} ${bed.position.y + 1} ${bed.position.z}`);
    await delay(500);
    
    // FEATURE: Click bed 3 times to test for thunder/night sleep
    for (let i = 0; i < 3; i++) {
      console.log(`🛌 Sleep Attempt ${i + 1}/3...`);
      try {
        await bot.lookAt(bed.position.offset(0.5, 0.5, 0.5), true);
        await bot.sleep(bed);
        bot.once("wake", () => {
          isSleeping = false; isProcessing = false;
          startAILoop();
        });
        return; // Success, exit loop
      } catch (e) {
        await delay(1000);
      }
    }
    
    console.log("🌦️ Not thunder. Resuming activities.");
    isSleeping = false; isProcessing = false;
  } else {
    isSleeping = false; isProcessing = false;
  }
}

// --- COMBAT (FEATURE 6) ---
async function combatScan() {
  const target = bot.nearestEntity((e) => {
    if (e.type !== 'mob') return false;
    const hostiles = ['zombie', 'skeleton', 'spider', 'creeper'];
    const distToCenter = e.position.distanceTo(new Vec3(config.circleCenter.x, config.circleCenter.y, config.circleCenter.z));
    // Attacks only if inside circle radius
    return hostiles.some(h => e.name.toLowerCase().includes(h)) && distToCenter <= (config.radius + 2);
  });

  if (target) {
    await bot.lookAt(target.position.offset(0, 1, 0));
    bot.attack(target);
  }
}

// --- MAIN AI LOOP ---
async function startAILoop() {
  if (isProcessing || isSleeping) return;

  if (config.autoSleep && (bot.time.timeOfDay >= 13000 || bot.isRaining)) {
    await handleSleepLogic();
    return;
  }

  await combatScan();
  await cleanTerritory(); // Ensure surface is plain

  isProcessing = true;
  try {
    await walkCircle(true);
    await placeAndBreak();
    await walkCircle(false);
    await placeAndBreak();
  } catch (e) {}
  
  isProcessing = false;
  setImmediate(startAILoop);
}

async function walkCircle(clockwise) {
  const num = config.pointsPerCircle || 8;
  for (let i = 0; i < num; i++) {
    if (bot.isRaining || bot.time.timeOfDay >= 13000) return;
    const angle = (2 * Math.PI * i / num) * (clockwise ? 1 : -1);
    const p = {
      x: config.circleCenter.x + config.radius * Math.cos(angle),
      z: config.circleCenter.z + config.radius * Math.sin(angle)
    };
    bot.setControlState("jump", true);
    bot.pathfinder.setGoal(new goals.GoalNear(p.x, config.circleCenter.y, p.z, 2));
    await waitForTarget(p);
    bot.setControlState("jump", false);
    await combatScan();
  }
}

async function placeAndBreak() {
  const mcData = require("minecraft-data")(bot.version);
  const type = config.blockType || 'dirt';
  await ensureCreativeItem(type, 1);
  const item = bot.inventory.findInventoryItem(mcData.itemsByName[type].id);
  
  if (item) {
    await bot.equip(item, "hand");
    const ref = bot.blockAt(bot.entity.position.offset(0, -1, 1));
    await bot.placeBlock(ref, new Vec3(0, 1, 0)).catch(() => {});
    
    // FEATURE: Immediate destroy after placing
    await delay(150); 
    const target = bot.blockAt(bot.entity.position.offset(0, 0, 1));
    if (target && target.name !== 'air') await bot.dig(target).catch(() => {});
  }
}

async function waitForTarget(p) {
  return new Promise((res) => {
    const timer = setTimeout(res, 5000);
    const check = setInterval(() => {
      if (bot.entity.position.distanceTo(new Vec3(p.x, config.circleCenter.y, p.z)) < 2.5) {
        clearInterval(check); clearTimeout(timer); res();
      }
    }, 200);
  });
}

async function ensureCreativeItem(name, count) {
  if (creativeInventoryLock || !bot.creative) return;
  creativeInventoryLock = true;
  const mcData = require("minecraft-data")(bot.version);
  const item = mcData.itemsByName[name];
  if (item && !bot.inventory.findInventoryItem(item.id)) {
    await bot.creative.setInventorySlot(36, new (require("prismarine-item")(bot.version))(item.id, count));
  }
  creativeInventoryLock = false;
}

function delay(ms) { return new Promise(res => setTimeout(res, ms)); }
