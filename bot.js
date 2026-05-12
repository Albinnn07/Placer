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

function createBot() {
  console.log(`🔄 Creating bot... (Attempt ${reconnectAttempts + 1})`);
  bot = mineflayer.createBot(botOptions);
  setupBotHandlers();
  return bot;
}

createBot();

function setupBotHandlers() {
  bot.loadPlugin(pathfinder);

  bot.on("spawn", () => {
    console.log("✅ Placer Bot spawned and active.");
    reconnectAttempts = 0;
    isProcessing = false;
    isSleeping = false;
    isFlyingMode = false;
    lastPosition = null;
    lastMoveTime = Date.now();

    const mcData = require("minecraft-data")(bot.version);
    const defaultMove = new Movements(bot, mcData);
    
    defaultMove.canDig = true;
    defaultMove.canPlace = true;
    defaultMove.allowParkour = true;
    defaultMove.allowSprinting = true;
    defaultMove.allowJump = true;
    defaultMove.maxDropHeight = 10;
    defaultMove.maxJumpHeight = 2;

    bot.pathfinder.setMovements(defaultMove);

    setTimeout(() => {
      checkAndSwitchToCreative();
      startMonitoring();
      startAntiStuck();
      startCombatSystem();
      startCircularPattern();
    }, 2500);
  });

  bot.on("kicked", (reason) => { console.log(`🚪 Kicked: ${reason}`); attemptReconnect(); });
  bot.on("end", () => { console.log("🔌 Connection ended"); attemptReconnect(); });
  bot.on("error", (err) => { console.log("❌ Error:", err.message); attemptReconnect(); });
}

function attemptReconnect() {
  reconnectAttempts++;
  const delay = Math.min(4000 * reconnectAttempts, 25000);
  console.log(`🔄 Reconnecting in ${delay/1000}s...`);
  setTimeout(() => {
    if (bot) bot.quit();
    createBot();
  }, delay);
}

// ====================== AI ANTI-STUCK + FLYING ======================
function startAntiStuck() {
  if (stuckCheckInterval) clearInterval(stuckCheckInterval);
  
  stuckCheckInterval = setInterval(() => {
    if (isSleeping || !bot?.entity) return;

    const currentPos = bot.entity.position;
    const vel = bot.entity.velocity;
    const speed = Math.sqrt(vel.x**2 + vel.z**2);

    if (!lastPosition) {
      lastPosition = currentPos.clone();
      lastMoveTime = Date.now();
      return;
    }

    const distanceMoved = currentPos.distanceTo(lastPosition);

    if (distanceMoved < 0.4 && speed < 0.1 && bot.pathfinder.isMoving()) {
      if (Date.now() - lastMoveTime > 4500) {
        console.log("🧠 AI: Stuck detected → Flying Recovery");
        bot.pathfinder.stop();
        const pos = bot.entity.position;
        bot.chat(`/tp ${Math.floor(pos.x)} ${Math.floor(pos.y + 8)} ${Math.floor(pos.z)}`);
        isFlyingMode = true;
        setTimeout(() => { isFlyingMode = false; }, 10000);
        lastMoveTime = Date.now();
      }
    } else {
      lastPosition = currentPos.clone();
      lastMoveTime = Date.now();
    }
  }, 1400);
}

// ====================== FLYING CIRCLE ======================
async function flyInCircle() {
  if (!bot?.entity || isFlyingMode) return;
  console.log("🕊️ Starting Flying Circle Mode");
  isFlyingMode = true;

  const center = config.circleCenter;
  const radius = config.radius || 20;
  const flyHeight = Math.floor(config.circleCenter.y || bot.entity.position.y) + 8;

  for (let lap = 0; lap < 4; lap++) {
    if (!isFlyingMode) break;
    for (let angle = 0; angle < 360; angle += 25) {
      if (!isFlyingMode) break;
      const rad = (angle * Math.PI) / 180;
      const x = center.x + radius * Math.cos(rad);
      const z = center.z + radius * Math.sin(rad);
      bot.chat(`/tp ${Math.floor(x)} ${flyHeight} ${Math.floor(z)}`);
      await new Promise(r => setTimeout(r, 500));
    }
  }
  isFlyingMode = false;
  console.log("🕊️ Flying Circle Mode ended");
}

// ====================== COMBAT ======================
function startCombatSystem() {
  if (combatInterval) clearInterval(combatInterval);
  combatInterval = setInterval(() => {
    if (isSleeping || isProcessing || isNightTime() || !bot?.entity) return;

    const circleCenter = config.circleCenter;
    const radius = config.radius || 20;
    const entitiesArray = Object.values(bot.entities || {});

    const nearbyMobs = entitiesArray.filter(entity => {
      if (!entity || entity.type !== 'mob') return false;
      if (bot.entity.position.distanceTo(entity.position) > 12) return false;
      const distToCenter = Math.hypot(entity.position.x - circleCenter.x, entity.position.z - circleCenter.z);
      return distToCenter <= radius + 5;
    });

    if (nearbyMobs.length > 0) {
      const target = nearbyMobs[0];
      console.log(`⚔️ Attacking ${target.name || 'mob'}`);
      bot.lookAt(target.position.offset(0, 1.2, 0), true);
      if (bot.entity.position.distanceTo(target.position) < 4.5) {
        bot.attack(target);
      } else {
        bot.pathfinder.setGoal(new goals.GoalFollow(target, 3));
      }
    }
  }, 800);
}

// ====================== AGGRESSIVE CLEANUP - ALL BLOCKS ABOVE Y=87 ======================
async function clearAllPlacedBlocksInCircle(passes = 3) {
  const center = config.circleCenter;
  const radius = config.radius || 20;
  const MIN_Y = 87;
  let totalDestroyed = 0;

  console.log("🧹 Starting aggressive cleanup (All blocks Y >= 87 in circle)...");

  for (let pass = 0; pass < passes; pass++) {
    let destroyedThisPass = 0;
    const blocks = bot.findBlocks({
      matching: b => b.name !== 'air' && !b.name.includes('bed'),
      maxDistance: radius + 25,
      count: 300
    });

    for (const pos of blocks) {
      const distToCenter = Math.hypot(pos.x - center.x, pos.z - center.z);
      if (distToCenter <= radius + 12 && pos.y >= MIN_Y) {
        try {
          const block = bot.blockAt(pos);
          if (block && block.name !== 'air' && !block.name.includes('bed')) {
            await bot.dig(block).catch(() => {});
            destroyedThisPass++;
            totalDestroyed++;
            await new Promise(r => setTimeout(r, 70));
          }
        } catch (e) {}
      }
    }

    if (destroyedThisPass > 0) {
      console.log(`🧹 Pass ${pass+1}: Cleaned ${destroyedThisPass} blocks`);
    }
    await new Promise(r => setTimeout(r, 400));
  }
  
  if (totalDestroyed > 0) console.log(`✅ Total cleaned ${totalDestroyed} blocks above Y=87`);
}

// ====================== SLEEP ======================
function isRaining() {
  return bot.isRaining === true;
}

function isNightTime() {
  return bot.time.timeOfDay >= 13000 && bot.time.timeOfDay < 23000;
}

async function clearNearbyMonsters() {
  bot.chat("/kill @e[type=!player,distance=..30]");
  await new Promise(r => setTimeout(r, 600));
}

async function tryToSleep() {
  if (isSleeping || !bot?.entity) return;
  isSleeping = true;
  isProcessing = true;
  bot.pathfinder.setGoal(null);

  console.log("🌙 Night/Rain detected → Preparing sleep");

  try {
    await clearNearbyMonsters();

    const bedNames = ["red_bed","white_bed","blue_bed","yellow_bed","black_bed","brown_bed","orange_bed","pink_bed"];
    let bed = bot.findBlock({ matching: b => bedNames.includes(b.name), maxDistance: 60 });

    if (!bed) {
      const mcData = require("minecraft-data")(bot.version);
      await ensureItemInCreativeInventory("red_bed", 1);
      const bedItem = bot.inventory.findInventoryItem(mcData.itemsByName.red_bed.id);
      
      if (bedItem) {
        await bot.equip(bedItem, "hand");
        const refPos = bot.entity.position.floored().offset(2, -1, 0);
        const refBlock = bot.blockAt(refPos);
        if (refBlock && refBlock.name !== 'air') {
          await bot.lookAt(refBlock.position.offset(0.5, 1.2, 0.5), true);
          await bot.placeBlock(refBlock, new Vec3(0, 1, 0)).catch(() => {});
          await new Promise(r => setTimeout(r, 600));
        }
        bed = bot.findBlock({ matching: b => bedNames.includes(b.name), maxDistance: 20 });
      }
    }

    if (bed) {
      let attempts = 0;
      const maxAttempts = 6;

      while (attempts < maxAttempts) {
        try {
          await bot.pathfinder.goto(new goals.GoalGetToBlock(bed.position.x, bed.position.y, bed.position.z), { timeout: 7000 })
            .catch(() => {});

          await bot.lookAt(bed.position.offset(0.5, 0.6, 0.5), true);
          await new Promise(r => setTimeout(r, 400));

          await bot.sleep(bed);
          console.log("✅ Bot is now sleeping");
          break;
        } catch (err) {
          attempts++;
          if (attempts >= 4) {
            bot.chat(`/tp ${bed.position.x} ${bed.position.y + 1} ${bed.position.z}`);
            await new Promise(r => setTimeout(r, 1000));
          } else {
            bot.setControlState('jump', true);
            setTimeout(() => bot.setControlState('jump', false), 600);
            await new Promise(r => setTimeout(r, 700));
          }
        }
      }

      bot.once("wake", () => {
        console.log("🌅 Bot woke up");
        isSleeping = false;
        isProcessing = false;
        startCircularPattern();
      });
    } else {
      isSleeping = false;
      isProcessing = false;
      startCircularPattern();
    }
  } catch (e) {
    isSleeping = false;
    isProcessing = false;
    startCircularPattern();
  }
}

// ====================== MAIN PATTERN ======================
async function startCircularPattern() {
  if (isProcessing || isSleeping || !bot?.entity) {
    setTimeout(startCircularPattern, 2000);
    return;
  }
  isProcessing = true;

  if (config.autoSleep && (isNightTime() || isRaining())) {
    isProcessing = false;
    await tryToSleep();
    return;
  }

  if (Math.random() < 0.22 && !isFlyingMode) {
    await flyInCircle();
  }

  await walkCircle(true);
  await placeAndBreakBlock();
  await walkCircle(false);
  await placeAndBreakBlock();

  await clearAllPlacedBlocksInCircle(3);   // Aggressive cleanup

  isProcessing = false;
  setImmediate(startCircularPattern);
}

async function walkCircle(clockwise) {
  const numPoints = config.pointsPerCircle || 8;
  const points = [];
  for (let i = 0; i < numPoints; i++) {
    const angle = (2 * Math.PI * i / numPoints) * (clockwise ? 1 : -1);
    points.push({
      x: Math.floor(config.circleCenter.x + config.radius * Math.cos(angle)),
      z: Math.floor(config.circleCenter.z + config.radius * Math.sin(angle))
    });
  }

  for (const p of points) {
    if (config.autoSleep && (isNightTime() || isRaining())) {
      isProcessing = false;
      return;
    }
    bot.pathfinder.setGoal(new goals.GoalNear(p.x, config.circleCenter.y, p.z, 1));
    await new Promise(resolve => {
      const timeout = setTimeout(() => resolve(), 8000);
      const check = setInterval(() => {
        if (bot.entity.position.distanceTo({ x: p.x, y: config.circleCenter.y, z: p.z }) < 2.8) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 350);
    });
  }
}

async function placeAndBreakBlock() {
  const mcData = require("minecraft-data")(bot.version);
  const blockName = config.blockType || 'dirt';
  await ensureItemInCreativeInventory(blockName, 1);
  const item = bot.inventory.findInventoryItem(mcData.itemsByName[blockName].id);
  
  if (item) {
    await bot.equip(item, "hand");
    const ref = bot.blockAt(bot.entity.position.offset(0, -1, 1));
    await bot.placeBlock(ref, new Vec3(0, 1, 0)).catch(() => {});
    await new Promise(r => setTimeout(r, 250));

    const target = bot.blockAt(bot.entity.position.offset(0, 0, 1));
    if (target && target.name !== 'air') {
      await bot.dig(target).catch(() => {});
    }
  }
}

// ====================== MONITORING ======================
function startMonitoring() {
  setInterval(() => {
    checkAndSwitchToCreative();
    if (config.autoSleep && (isNightTime() || isRaining()) && !isSleeping && !isProcessing) {
      tryToSleep();
    }
  }, 4500);
}

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

function checkAndSwitchToCreative() {
  if (bot.game.gameMode !== "creative") bot.chat("/gamemode creative");
}
