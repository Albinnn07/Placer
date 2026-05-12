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
let stuckCheckInterval = null;
let combatInterval = null;
let reconnectAttempts = 0;
let lastPosition = null;
let lastMoveTime = Date.now();
let isFlyingMode = false;

// 10. Powerful Auto Reconnect
function createBot() {
  if (bot) bot.removeAllListeners();
  console.log(`🔄 Reconnect Attempt #${reconnectAttempts + 1}`);
  bot = mineflayer.createBot(botOptions);
  setupBotHandlers();
}

createBot();

function setupBotHandlers() {
  bot.loadPlugin(pathfinder);

  bot.on("spawn", () => {
    console.log("✅ AI Brain Online. All 14 features active.");
    reconnectAttempts = 0;
    isProcessing = false;
    isSleeping = false;
    isFlyingMode = false;
    lastPosition = null;
    lastMoveTime = Date.now();

    const mcData = require("minecraft-data")(bot.version);
    const defaultMove = new Movements(bot, mcData);
    bot.pathfinder.setMovements(defaultMove);

    setTimeout(() => {
      // 14. Auto Creative mode enforcement
      checkAndSwitchToCreative();
      startMonitoring();
      // 7. Advanced Anti-Stuck AI
      startAntiStuck();
      // 6. Daytime only combat (restricted to circle)
      startCombatSystem();
      // 1. Circular walking pattern
      startCircularPattern();
    }, 2500);
  });

  bot.on("kicked", () => setTimeout(createBot, 10000));
  bot.on("end", () => setTimeout(createBot, 10000));
  bot.on("error", () => setTimeout(createBot, 10000));
}

// 7 & 8. Anti-Stuck & Flying Recovery
function startAntiStuck() {
  if (stuckCheckInterval) clearInterval(stuckCheckInterval);
  stuckCheckInterval = setInterval(() => {
    if (isSleeping || !bot?.entity) return;
    const pos = bot.entity.position;
    if (!lastPosition) { lastPosition = pos.clone(); lastMoveTime = Date.now(); return; }

    if (pos.distanceTo(lastPosition) < 0.4 && bot.pathfinder.isMoving()) {
      if (Date.now() - lastMoveTime > 4500) {
        // 8. Flying recovery when stuck
        bot.pathfinder.stop();
        bot.chat(`/tp ${pos.x} ${pos.y + 8} ${pos.z}`);
        isFlyingMode = true;
        setTimeout(() => { isFlyingMode = false; }, 8000);
        lastMoveTime = Date.now();
      }
    } else {
      lastPosition = pos.clone();
      lastMoveTime = Date.now();
    }
  }, 1500);
}

// 9. Random Flying Circle Mode
async function flyInCircle() {
  if (isFlyingMode) return;
  isFlyingMode = true;
  console.log("🕊️ AI: Entering Random Flying Mode");
  const flyHeight = config.circleCenter.y + 8;
  for (let angle = 0; angle < 360; angle += 40) {
    const rad = (angle * Math.PI) / 180;
    const x = config.circleCenter.x + config.radius * Math.cos(rad);
    const z = config.circleCenter.z + config.radius * Math.sin(rad);
    bot.chat(`/tp ${x} ${flyHeight} ${z}`);
    await new Promise(r => setTimeout(r, 600));
  }
  isFlyingMode = false;
}

// 6. Daytime Combat (Stay in Circle)
function startCombatSystem() {
  if (combatInterval) clearInterval(combatInterval);
  combatInterval = setInterval(() => {
    if (isSleeping || isNightTime() || !bot?.entity) return;
    const target = bot.nearestEntity((e) => {
      if (e.type !== 'mob') return false;
      const hostiles = ['zombie', 'skeleton', 'spider', 'creeper'];
      const distToCenter = Math.hypot(e.position.x - config.circleCenter.x, e.position.z - config.circleCenter.z);
      return hostiles.some(h => e.name.toLowerCase().includes(h)) && distToCenter <= (config.radius + 3);
    });
    if (target) {
      bot.lookAt(target.position.offset(0, 1.2, 0), true);
      if (bot.entity.position.distanceTo(target.position) < 4) bot.attack(target);
    }
  }, 800);
}

// 4, 5, 11, 12, 13. Sleep Logic
async function tryToSleep() {
  if (isSleeping || !bot?.entity) return;
  isSleeping = true;
  isProcessing = true;
  bot.pathfinder.setGoal(null);

  try {
    // 13. Aggressive monster clearing before sleep
    bot.chat("/kill @e[type=!player,distance=..20]");
    await new Promise(r => setTimeout(r, 600));

    // 11. Auto bed finding/placing
    const bedNames = ["red_bed", "white_bed", "blue_bed", "yellow_bed"];
    let bed = bot.findBlock({ matching: b => bedNames.includes(b.name), maxDistance: 40 });

    if (!bed) {
      await ensureItemInCreativeInventory("red_bed", 1);
      const item = bot.inventory.findInventoryItem(require("minecraft-data")(bot.version).itemsByName.red_bed.id);
      if (item) {
        await bot.equip(item, "hand");
        const ref = bot.blockAt(bot.entity.position.offset(2, -1, 0));
        await bot.placeBlock(ref, new Vec3(0, 1, 0)).catch(() => {});
        await new Promise(r => setTimeout(r, 600));
        bed = bot.findBlock({ matching: b => bedNames.includes(b.name), maxDistance: 10 });
      }
    }

    if (bed) {
      // 12. Teleport to bed as last resort
      bot.chat(`/tp ${bed.position.x} ${bed.position.y + 1} ${bed.position.z}`);
      await new Promise(r => setTimeout(r, 500));
      // 5. Smart sleep (tries in any rain)
      await bot.sleep(bed).catch(() => {
        isSleeping = false; isProcessing = false;
      });
      bot.once("wake", () => { isSleeping = false; isProcessing = false; });
    } else {
      isSleeping = false; isProcessing = false;
    }
  } catch (e) { isSleeping = false; isProcessing = false; }
}

// 1. Walking Pattern & 3. Recursive Cleanup
async function startCircularPattern() {
  if (isProcessing || isSleeping || !bot?.entity) { setTimeout(startCircularPattern, 2000); return; }
  isProcessing = true;

  if (config.autoSleep && (isNightTime() || bot.isRaining)) {
    isProcessing = false;
    await tryToSleep();
    return;
  }

  if (Math.random() < 0.15) await flyInCircle(); // 9. Random flight

  await walkCircle(true);  // Clockwise
  await placeAndBreakBlock();
  await walkCircle(false); // Anti-clockwise
  await placeAndBreakBlock();

  // 3. Recursive cleanup (All blocks Y >= center-Y)
  bot.chat(`/fill ${config.circleCenter.x - 15} ${config.circleCenter.y} ${config.circleCenter.z - 15} ${config.circleCenter.x + 15} ${config.circleCenter.y + 5} ${config.circleCenter.z + 15} air replace dirt`);

  isProcessing = false;
  setImmediate(startCircularPattern);
}

async function walkCircle(clockwise) {
  const points = [];
  for (let i = 0; i < (config.pointsPerCircle || 8); i++) {
    const angle = (2 * Math.PI * i / 8) * (clockwise ? 1 : -1);
    points.push({
      x: config.circleCenter.x + config.radius * Math.cos(angle),
      z: config.circleCenter.z + config.radius * Math.sin(angle)
    });
  }
  for (const p of points) {
    if (isNightTime() || bot.isRaining) return;
    bot.setControlState('jump', true);
    bot.pathfinder.setGoal(new goals.GoalNear(p.x, config.circleCenter.y, p.z, 2));
    await new Promise(res => {
      const t = setTimeout(res, 5000);
      const i = setInterval(() => {
        if (bot.entity.position.distanceTo({x:p.x, y:config.circleCenter.y, z:p.z}) < 3) { clearInterval(i); clearTimeout(t); res(); }
      }, 300);
    });
    bot.setControlState('jump', false);
  }
}

// 2. Place block + immediate destroy
async function placeAndBreakBlock() {
  const mcData = require("minecraft-data")(bot.version);
  const blockName = config.blockType || 'dirt';
  await ensureItemInCreativeInventory(blockName, 1);
  const item = bot.inventory.findInventoryItem(mcData.itemsByName[blockName].id);
  if (item) {
    await bot.equip(item, "hand");
    const ref = bot.blockAt(bot.entity.position.offset(0, -1, 1));
    await bot.placeBlock(ref, new Vec3(0, 1, 0)).catch(() => {});
    await new Promise(r => setTimeout(r, 100)); // 2. Immediate
    const target = bot.blockAt(bot.entity.position.offset(0, 0, 1));
    if (target && target.name !== 'air') await bot.dig(target).catch(() => {});
  }
}

function isNightTime() { return bot.time.timeOfDay >= 13000; }

function startMonitoring() { setInterval(checkAndSwitchToCreative, 4500); }

async function ensureItemInCreativeInventory(name, count) {
  if (creativeInventoryLock || !bot?.creative) return;
  creativeInventoryLock = true;
  const mcData = require("minecraft-data")(bot.version);
  const item = mcData.itemsByName[name];
  if (item && !bot.inventory.findInventoryItem(item.id)) {
    await bot.creative.setInventorySlot(36, new (require("prismarine-item")(bot.version))(item.id, count));
  }
  creativeInventoryLock = false;
}

function checkAndSwitchToCreative() { if (bot.game.gameMode !== "creative") bot.chat("/gamemode creative"); }
